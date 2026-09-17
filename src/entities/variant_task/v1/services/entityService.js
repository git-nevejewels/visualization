// src/entities/variant_task/v1/services/entityService.js
const Joi = require('joi');
const { Sequelize, Op } = require('sequelize');
const _ = require('lodash');
const path = require('path');
const logger = require('../../../../common/v1/utils/logger');

// --------------------
// Auto-import global Sequelize instance
// --------------------
const defaultSequelize = require('../../../../common/v1/db/sequelize');
const { executeOperation } = require('../../../../../utils/queryExecutor');

// --------------------
// Infer entityName & version from folder structure
// --------------------
const servicesFolder = __dirname;
const version = path.basename(path.dirname(servicesFolder));
const entityName = path.basename(path.dirname(path.dirname(servicesFolder)));

// --------------------
// Helpers for field names
// --------------------
const getEntityIdField = () => `${entityName.toLowerCase()}_id`;
const getDetailsField = () => `${entityName.toLowerCase()}_details`;

// --------------------
// Model Resolvers
// --------------------
const resolveModelName = () => `${entityName.toLowerCase()}`;
const resolveHistoryModelName = () => `${entityName.toLowerCase()}_history`;

const getEntityModel = () => {
  const model = defaultSequelize.models[resolveModelName()];
  if (!model) throw new Error(`Model not loaded: ${resolveModelName()}`);
  return model;
};

const getEntityHistoryModel = () => {
  const model = defaultSequelize.models[resolveHistoryModelName()];
  if (!model) throw new Error(`History model not loaded: ${resolveHistoryModelName()}`);
  return model;
};

// --------------------
// Validation
// --------------------
const getValidationSchema = () => {
  const detailsField = getDetailsField();
  try {
    const schemaDef = require(`../schemas/${entityName}Schema.json`)[detailsField];
    if (!schemaDef) throw new Error();
    return Joi.object(schemaDef);
  } catch (err) {
    throw new Error(`No schema found for entity '${entityName}'`);
  }
};

// --------------------
// CRUD Helpers
// --------------------
// Matches D:\work\cad\src\entities\{cad_request,component}\v1\services\entityService.js
// byte-for-byte (the newer of two incompatible buildWhereClause patterns found
// across cad/mdm/merchandising — the older one, still present in most other
// entities including design_request, silently never worked: it used a
// Sequelize.literal instance as a computed object key, which JS coerces to
// the string "[object Object]"). Adopted here instead of a bespoke fix so
// Visualization matches the ecosystem's own newest precedent rather than
// introducing a fourth variant. NOTE the calling convention this implies:
// filterQuery keys must be fully qualified with the JSONB column name to
// reach into it, e.g. {"variant_task_details.componentSetId": "..."} or the
// equivalent nested form {"variant_task_details": {"componentSetId": "..."}}
// — a bare {"componentSetId": "..."} is treated as a literal top-level
// column (which doesn't exist) and will error, same as in cad_request/component.
const buildWhereClause = (filterQuery = {}, parentKey = '', whereClause = {}) => {
  if (!filterQuery || typeof filterQuery !== 'object') return whereClause;
  Object.entries(filterQuery).forEach(([key, value]) => {
    const fullKey = parentKey ? `${parentKey}.${key}` : key;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      buildWhereClause(value, fullKey, whereClause);
    } else if (Array.isArray(value)) {
      whereClause[fullKey] = { [Op.in]: value };
    } else {
      whereClause[fullKey] = value;
    }
  });
  return whereClause;
};

const buildWhereSearchClause = (search, whereClause) => {
  const detailsField = getDetailsField();
  whereClause[Op.and] = whereClause[Op.and] || [];
  Object.keys(search).forEach(key => {
    whereClause[Op.and].push(
      Sequelize.where(
        Sequelize.literal(`"${detailsField}"->>'${key}'`),
        { [Op.iLike]: `${search[key]}` }
      )
    );
  });
};

const buildSelectedAttributes = (fields) => {
  if (!fields) return undefined;
  const detailsField = getDetailsField();
  return fields.split(',').map(f => [
    Sequelize.json(`${detailsField}.${f}`),
    f.replace(/\./g, '_'),
  ]);
};

const getUpdatedFields = (oldObj, newObj, prefix = '') => {
  let fields = [];
  for (const k in newObj) {
    const pathKey = prefix ? `${prefix}.${k}` : k;
    if (_.isObject(newObj[k]) && !Array.isArray(newObj[k])) {
      fields.push(...getUpdatedFields(oldObj[k] || {}, newObj[k], pathKey));
    } else if (!_.isEqual(oldObj[k], newObj[k])) {
      fields.push(pathKey);
    }
  }
  return fields;
};

// --------------------
// CRUD Operations
// Each accepts an optional logContext param: { correlationId, processName }
// --------------------
// Defaults status to 'Ready' (both the top-level column AND variant_task_details.status) when the
// caller doesn't supply one — matching the exact convention createNextStageTaskIfNeeded already
// uses when it auto-creates an obj/rn task (see below). Without this, a freshly created task had
// NO status at all (`status: data.status` was simply `undefined` unless a caller explicitly passed
// one — nothing in this codebase did), and performAction's own transition logic requires 'Ready'
// before 'assign' can ever succeed — so a task created through this public endpoint could never
// enter the assign/start/advance/hold/complete workflow at all. Found 2026-09-15 while testing
// image_request's dashboard rollup — see GAPS.md. The top-level column and the JSONB copy are two
// separately-writable facts kept in sync only by convention (performAction does this correctly on
// every transition) — this fix keeps create() consistent with that same convention.
async function create(data, logContext = {}) {
  const model = getEntityModel();
  const detailsField = getDetailsField();

  const details = data[detailsField] || data;
  const status = data.status || details.status || 'Ready';

  return executeOperation(
    () =>
      model.create({
        [detailsField]: { ...details, status },
        created_by: data.created_by,
        updated_by: data.updated_by,
        api_version: version,
        status,
      }),
    {
      processName: logContext.processName || `Create_${entityName}`,
      correlationId: logContext.correlationId,
      metadata: { entityName, version },
    }
  );
}

async function bulkCreate(dataArray, logContext = {}) {
  const model = getEntityModel();
  const idField = getEntityIdField();
  const detailsField = getDetailsField();

  return executeOperation(
    () =>
      model.bulkCreate(
        dataArray.map(d => {
          const details = d[detailsField] || d;
          const status = d.status || details.status || 'Ready'; // same default as create() above
          return {
            [idField]: d[idField],
            [detailsField]: { ...details, status },
            created_by: d.created_by,
            updated_by: d.updated_by,
            api_version: version,
            status,
          };
        })
      ),
    {
      processName: logContext.processName || `BulkCreate_${entityName}`,
      correlationId: logContext.correlationId,
      metadata: { entityName, version, recordCount: dataArray.length },
    }
  );
}

async function getAll(page = 1, pageSize = 20, filterQuery = {}, fields, search = {}, logContext = {}) {
  const model = getEntityModel();

  const whereClause = buildWhereClause(filterQuery);
  if (Object.keys(search).length > 0) buildWhereSearchClause(search, whereClause);

  return executeOperation(
    () =>
      model.findAndCountAll({
        where: whereClause,
        limit: pageSize,
        offset: (page - 1) * pageSize,
        attributes: buildSelectedAttributes(fields),
      }),
    {
      processName: logContext.processName || `GetAll_${entityName}`,
      correlationId: logContext.correlationId,
      metadata: { entityName, page, pageSize },
    }
  );
}

async function getById(id, fields, filterQuery = {}, logContext = {}) {
  const model = getEntityModel();
  const idField = getEntityIdField();

  return executeOperation(
    () =>
      model.findOne({
        where: { ...buildWhereClause(filterQuery), [idField]: id },
        attributes: buildSelectedAttributes(fields),
      }),
    {
      processName: logContext.processName || `GetById_${entityName}`,
      correlationId: logContext.correlationId,
      metadata: { entityName, entityId: id },
    }
  );
}

async function update(id, payload, logContext = {}) {
  const model = getEntityModel();
  const historyModel = getEntityHistoryModel();
  const idField = getEntityIdField();
  const detailsField = getDetailsField();

  return executeOperation(
    async () => {
      const entity = await model.findOne({ where: { [idField]: id } });
      if (!entity) return null;

      const mergedDetails = _.merge(
        {},
        entity[detailsField],
        payload[detailsField] || payload
      );

      const updatedFields = getUpdatedFields(
        entity[detailsField],
        mergedDetails
      );

      await historyModel.create({
        [idField]: id,
        [detailsField]: entity[detailsField],
        updated_fields: updatedFields,
        status: entity.status,
        api_version: entity.api_version,
      });

      await entity.update({
        [detailsField]: mergedDetails,
        api_version: version,
      });

      logger.debug({
        message: `Update_${entityName}: updated fields [${updatedFields.join(', ')}]`,
        messageType: 'EVENT',
        processName: logContext.processName || `Update_${entityName}`,
        correlationId: logContext.correlationId,
        metadata: { entityName, entityId: id, updatedFields },
      });

      return entity;
    },
    {
      processName: logContext.processName || `Update_${entityName}`,
      correlationId: logContext.correlationId,
      metadata: { entityName, entityId: id },
    }
  );
}

async function deleteEntity(id, logContext = {}) {
  const model = getEntityModel();
  const historyModel = getEntityHistoryModel();
  const idField = getEntityIdField();
  const detailsField = getDetailsField();

  return executeOperation(
    async () => {
      const entity = await model.findOne({ where: { [idField]: id } });
      if (!entity) return null;

      await historyModel.create({
        [idField]: id,
        [detailsField]: entity[detailsField],
        status: entity.status,
        api_version: entity.api_version,
      });

      await entity.destroy();

      logger.debug({
        message: `Delete_${entityName}: entity ${id} deleted with history record`,
        messageType: 'EVENT',
        processName: logContext.processName || `Delete_${entityName}`,
        correlationId: logContext.correlationId,
        metadata: { entityName, entityId: id },
      });

      return entity;
    },
    {
      processName: logContext.processName || `Delete_${entityName}`,
      correlationId: logContext.correlationId,
      metadata: { entityName, entityId: id },
    }
  );
}

// --------------------
// Task workflow actions — see ARCHITECTURE.md's "Task workflow" API surface and
// RULES.md. Mirrors visualization_studio_v15.html's assign()/start()/advance()/
// hold()/complete(), tightened into real preconditions since an API has no UI
// to gate which button is even shown (the wireframe's own functions don't
// self-validate — only the UI decides which one to expose via primary()).
//
// Deliberately NOT routed through executeOperation() for the validation step:
// queryExecutor.js's catch-all collapses every thrown error to a generic 500
// (it only special-cases SequelizeValidationError/SequelizeUniqueConstraintError/
// a Connection-named error) — a plain Error with a custom `.status = 400` would
// silently become an unhelpful 500. design_request's own getByStats() avoids
// this the same way: validate and throw BEFORE calling executeOperation, so the
// error reaches the controller directly (see entityController.js's
// `if (error.status === 400)` handling, copied from that same precedent).
// --------------------
const STAGE_ORDER = ['zb', 'obj', 'rn'];
const RENDER_CHAIN = ['Tool config', 'Keyshot', 'Photoshop'];
const VALID_ACTIONS = ['assign', 'start', 'advance', 'hold', 'complete'];

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

// Returns { status, setAssignee?, setAssigneeIfMissing?, isComplete? } or throws
// a 400 if `action` isn't legal from `currentStatus`/`stage` right now.
function computeTransition(action, stage, currentStatus) {
  if (!VALID_ACTIONS.includes(action)) {
    throw badRequest(`Unknown action '${action}'. Must be one of: ${VALID_ACTIONS.join(', ')}`);
  }
  if (currentStatus === 'Completed') {
    throw badRequest(`Cannot perform '${action}' — task is already Completed`);
  }

  if (action === 'assign') {
    if (currentStatus !== 'Ready') {
      throw badRequest(`Cannot assign — status is '${currentStatus}', must be 'Ready'`);
    }
    return { status: 'Assigned', setAssignee: true };
  }

  if (action === 'start') {
    if (currentStatus !== 'Assigned' && currentStatus !== 'On hold') {
      throw badRequest(`Cannot start — status is '${currentStatus}', must be 'Assigned' or 'On hold'`);
    }
    return { status: stage === 'rn' ? 'Tool config' : 'In progress', setAssigneeIfMissing: true };
  }

  if (action === 'advance') {
    if (stage !== 'rn') {
      throw badRequest(`'advance' is only valid for the render stage (rn), not '${stage}'`);
    }
    const idx = RENDER_CHAIN.indexOf(currentStatus);
    if (idx === -1) {
      throw badRequest(`Cannot advance — status is '${currentStatus}', must be one of: ${RENDER_CHAIN.join(', ')}`);
    }
    if (idx < RENDER_CHAIN.length - 1) {
      return { status: RENDER_CHAIN[idx + 1] };
    }
    // Already at the last chain step (Photoshop) — advancing from here completes
    // the task, matching the wireframe's own advance()'s fallthrough to complete().
    return { status: 'Completed', isComplete: true };
  }

  if (action === 'hold') {
    if (currentStatus === 'Ready') {
      throw badRequest(`Cannot hold — status is 'Ready', nothing in progress to pause`);
    }
    return { status: 'On hold' };
  }

  // action === 'complete'
  const requiredStatus = stage === 'rn' ? 'Photoshop' : 'In progress';
  if (currentStatus !== requiredStatus) {
    throw badRequest(`Cannot complete — status is '${currentStatus}', must be '${requiredStatus}'`);
  }
  return { status: 'Completed', isComplete: true };
}

// On completing a stage, auto-create the next stage's task for the same variant
// — unless one already exists (guards a double-complete race) or the completed
// stage was the last one (render — nothing follows it). New task always starts
// unassigned, status 'Ready', with every other field copied forward.
async function createNextStageTaskIfNeeded(completedDetails, logContext = {}) {
  const model = getEntityModel();
  const detailsField = getDetailsField();
  const idField = getEntityIdField();

  const stageIdx = STAGE_ORDER.indexOf(completedDetails.stage);
  const nextStage = STAGE_ORDER[stageIdx + 1];
  if (!nextStage) return null;

  const existing = await model.findOne({
    where: {
      [`${detailsField}.imageRequestId`]: completedDetails.imageRequestId,
      [`${detailsField}.componentSetId`]: completedDetails.componentSetId,
      [`${detailsField}.stage`]: nextStage,
    },
  });
  if (existing) return existing;

  const nextDetails = {
    imageRequestId: completedDetails.imageRequestId,
    baseDesignId: completedDetails.baseDesignId,
    componentSetId: completedDetails.componentSetId,
    metalTeamId: completedDetails.metalTeamId,
    metalTeamCode: completedDetails.metalTeamCode,
    stoneTeamId: completedDetails.stoneTeamId,
    stoneTeamCode: completedDetails.stoneTeamCode,
    stage: nextStage,
    dimensionalSelection: completedDetails.dimensionalSelection,
    metalColourGroups: completedDetails.metalColourGroups,
    stoneColours: completedDetails.stoneColours,
    priority: completedDetails.priority,
    neededBy: completedDetails.neededBy,
    status: 'Ready',
  };

  const created = await model.create({
    [detailsField]: nextDetails,
    api_version: version,
    status: 'Ready',
  });

  logger.debug({
    message: `Action_${entityName}: auto-created ${nextStage} task ${created[idField]} for componentSetId ${completedDetails.componentSetId}`,
    messageType: 'EVENT',
    processName: logContext.processName || `Action_${entityName}`,
    correlationId: logContext.correlationId,
    metadata: { entityName, componentSetId: completedDetails.componentSetId, nextStage },
  });

  return created;
}

async function performAction(id, action, payload = {}, logContext = {}) {
  const model = getEntityModel();
  const historyModel = getEntityHistoryModel();
  const idField = getEntityIdField();
  const detailsField = getDetailsField();

  const entity = await model.findOne({ where: { [idField]: id } });
  if (!entity) return { status: 404, data: null };

  const details = entity[detailsField] || {};
  const transition = computeTransition(action, details.stage, entity.status);

  if ((transition.setAssignee || (transition.setAssigneeIfMissing && !details.assignee)) && !payload.actionBy) {
    throw badRequest(`'actionBy' is required to ${action === 'assign' ? 'assign' : 'start'} this task`);
  }

  const newDetails = { ...details, status: transition.status };
  if (transition.setAssignee) newDetails.assignee = payload.actionBy;
  if (transition.setAssigneeIfMissing && !newDetails.assignee) newDetails.assignee = payload.actionBy;

  return executeOperation(
    async () => {
      const updatedFields = getUpdatedFields(details, newDetails);

      await historyModel.create({
        [idField]: id,
        [detailsField]: details,
        updated_fields: updatedFields,
        status: entity.status,
        api_version: entity.api_version,
      });

      await entity.update({
        [detailsField]: newDetails,
        status: transition.status,
        api_version: version,
        updated_by: payload.actionBy || entity.updated_by,
      });

      let nextTask = null;
      if (transition.isComplete) {
        nextTask = await createNextStageTaskIfNeeded(newDetails, logContext);
      }

      logger.debug({
        message: `Action_${entityName}: '${action}' applied — status '${entity.status}' -> '${transition.status}'`,
        messageType: 'EVENT',
        processName: logContext.processName || `Action_${entityName}`,
        correlationId: logContext.correlationId,
        metadata: { entityName, entityId: id, action, newStatus: transition.status, nextTaskId: nextTask ? nextTask[idField] : null },
      });

      return entity;
    },
    {
      processName: logContext.processName || `Action_${entityName}`,
      correlationId: logContext.correlationId,
      metadata: { entityName, entityId: id, action },
    }
  );
}

// Applies the same action to multiple ids. Not atomic — each id succeeds or
// fails independently and every outcome is reported, so one invalid transition
// in a batch never blocks the rest (matches the wireframe's own bulk(), which
// loops calling the action function per selected row regardless of the others).
async function bulkPerformAction(ids, action, payload = {}, logContext = {}) {
  const results = [];
  for (const id of ids) {
    try {
      const result = await performAction(id, action, payload, logContext);
      results.push({ id, status: result.status, data: result.data });
    } catch (err) {
      results.push({ id, status: err.status || 500, error: err.message });
    }
  }
  return results;
}

// POST /api/variant_task/v1/cad-file-uploaded — called by CAD's own service directly
// (service-to-service, not through the BFF), right after their CAD user pastes the FG CAD file's
// existing shared-drive path into a plain textbox on CAD's side and
// `component_set_details.componentSetCadPath` is set to that same string. Manager decision
// 2026-09-17 (revised further 2026-09-17): there is NO cloud upload anywhere in this flow — CAD
// users already save .3dm files to an existing "FG CAD" shared drive; `cadFilePath` is just that
// path string, copied through unchanged. This is a fire-and-forget NOTIFICATION, not a file
// transfer — no file bytes ever pass through Visualization, and never did. CAD has NO concept of
// Visualization's own `image_request` entity or
// `imageRequestId` (confirmed 2026-09-16 by reading D:\work\cad in full — no match anywhere for
// "image_request"/"imageRequestId"/"visualization"/"FG Ready" — see GAPS.md), so this takes ONLY
// `componentSetId` (+ `cadFilePath`, see below) and resolves which image_request(s) are actually
// waiting on it ITSELF.
//
// The same componentSetId can legitimately sit in more than one open request's own basket (two
// different people raising separate requests that happen to pick the same variant) — this creates
// a `zb` task for EVERY matching request that doesn't already have one, not just the first, since
// each request tracks its own variant_task rows independently. Zero matches is a valid, quiet
// no-op (nothing is currently waiting on this variant) — not an error, since CAD may upload a file
// for a variant nobody has requested images for yet.
//
// Idempotent by construction: re-calling for a componentSetId that already has a `zb` task for a
// given request just skips that request (added to `alreadyExistedFor`) rather than duplicating it
// — safe for CAD to retry this call if their own outbound call fails and they retry it.
//
// Deliberately a single direct call, no reconciliation poll on our side (2026-09-16 decision) —
// the known risk (a failed/never-retried call silently leaves a variant stuck with no zb task) is
// accepted for now rather than building a poller against the shared component_set table; revisit
// if that risk turns out to matter in practice.
async function handleCadFileUploaded(componentSetId, cadFilePath, logContext = {}) {
  if (!componentSetId) {
    const err = new Error('componentSetId is required');
    err.status = 400;
    throw err;
  }
  if (!cadFilePath) {
    const err = new Error('cadFilePath is required');
    err.status = 400;
    throw err;
  }

  const imageRequestModel = defaultSequelize.models['image_request'];
  if (!imageRequestModel) throw new Error('Model not loaded: image_request');
  const imageRequestHistoryModel = defaultSequelize.models['image_request_history'];
  if (!imageRequestHistoryModel) throw new Error('Model not loaded: image_request_history');

  const model = getEntityModel();
  const detailsField = getDetailsField();

  return executeOperation(
    async () => {
      const matchingRequests = await imageRequestModel.findAll({
        where: Sequelize.where(
          Sequelize.literal(`"image_request_details"->'requestedVariants'`),
          Op.contains,
          Sequelize.cast(JSON.stringify([{ componentSetId }]), 'jsonb')
        ),
      });

      const createdFor = [];
      const alreadyExistedFor = [];

      for (const req of matchingRequests) {
        const details = req.image_request_details || {};
        const variant = (details.requestedVariants || []).find(v => v.componentSetId === componentSetId);
        if (!variant) continue; // shouldn't happen given the containment match above, but don't trust it blindly

        // Manager decision 2026-09-17: this path (a plain FG-CAD shared-drive path string the CAD
        // user pastes in — no cloud upload anywhere in this flow) belongs on the variant itself
        // inside the visualization request, NOT on CAD's own component_set (master data) — the
        // visualization team needs to see the actual document reference while working a variant,
        // not just a flag. Its presence IS the "uploaded" signal (no separate boolean). Sets it on
        // every entry matching this componentSetId (it can legitimately appear more than once in the same basket with
        // different colour selections). Builds a NEW array rather than mutating `details` in
        // place, so the history row below still captures the pre-update state.
        const updatedRequestedVariants = (details.requestedVariants || []).map(v =>
          v.componentSetId === componentSetId && v.cadFilePath !== cadFilePath
            ? { ...v, cadFilePath }
            : v
        );
        if (!_.isEqual(updatedRequestedVariants, details.requestedVariants)) {
          await imageRequestHistoryModel.create({
            image_request_id: req.image_request_id,
            image_request_details: details,
            updated_fields: ['requestedVariants'],
            status: req.status,
            api_version: req.api_version,
          });
          await req.update({ image_request_details: { ...details, requestedVariants: updatedRequestedVariants } });
        }

        const existingTask = await model.findOne({
          where: {
            [`${detailsField}.imageRequestId`]: req.image_request_id,
            [`${detailsField}.componentSetId`]: componentSetId,
          },
        });
        if (existingTask) { alreadyExistedFor.push(req.image_request_id); continue; }

        await create({
          imageRequestId: req.image_request_id,
          baseDesignId: details.baseDesignId,
          componentSetId: variant.componentSetId,
          metalTeamId: variant.metalTeamId,
          metalTeamCode: variant.metalTeamCode,
          stoneTeamId: variant.stoneTeamId,
          stoneTeamCode: variant.stoneTeamCode,
          stage: 'zb',
          dimensionalSelection: variant.dimensionalSelection,
          metalColourGroups: variant.metalColourGroups,
          stoneColours: variant.stoneColours,
          priority: details.priority,
          neededBy: details.neededBy,
        }, logContext);
        createdFor.push(req.image_request_id);
      }

      return { componentSetId, createdFor, alreadyExistedFor };
    },
    {
      processName: logContext.processName || 'HandleCadFileUploaded_variant_task',
      correlationId: logContext.correlationId,
      metadata: { componentSetId },
    }
  );
}

module.exports = {
  getAll,
  getById,
  create,
  bulkCreate,
  update,
  deleteEntity,
  getValidationSchema,
  buildWhereClause,
  performAction,
  bulkPerformAction,
  handleCadFileUploaded,
};
