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
// filterQuery keys must be fully qualified with the JSONB column name to reach into it,
// e.g. {"variant_task_details.componentSetId": "..."} or the nested form
// {"variant_task_details": {"componentSetId": "..."}} — a bare {"componentSetId": "..."}
// is treated as a literal top-level column and will error.
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
// Defaults status to 'Ready' (both the top-level column and variant_task_details.status) when the
// caller doesn't supply one, since performAction requires 'Ready' before a task can be assigned.
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
// Task workflow actions — assign/start/hold/complete, each only legal from specific
// current statuses. rn additionally requires uploadedImages before it can complete.
//
// Validation happens before executeOperation() is called, not inside it:
// queryExecutor.js collapses any error it doesn't recognize to a generic 500, so a
// plain Error with a custom `.status = 400` needs to reach the controller directly
// (see entityController.js's `if (error.status === 400)` handling).
// --------------------
const STAGE_ORDER = ['zb', 'obj', 'rn'];
const VALID_ACTIONS = ['assign', 'start', 'hold', 'complete'];

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

// Returns { status, setAssignee?, setAssigneeIfMissing?, isComplete? } or throws
// a 400 if `action` isn't legal from `currentStatus`/`stage` right now. `details`
// is the task's own JSONB blob, needed only to check `uploadedImages` on a render
// (rn) 'complete'.
function computeTransition(action, stage, currentStatus, details = {}) {
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
    return { status: 'In progress', setAssigneeIfMissing: true };
  }

  if (action === 'hold') {
    if (currentStatus === 'Ready') {
      throw badRequest(`Cannot hold — status is 'Ready', nothing in progress to pause`);
    }
    return { status: 'On hold' };
  }

  if (currentStatus !== 'In progress') {
    throw badRequest(`Cannot complete — status is '${currentStatus}', must be 'In progress'`);
  }
  if (stage === 'rn' && !(details.uploadedImages?.length > 0)) {
    throw badRequest('Cannot complete the render (rn) stage — at least one image must be uploaded first (see POST /:id/images)');
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
  const transition = computeTransition(action, details.stage, entity.status, details);

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
// in a batch never blocks the rest.
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

// Called by CAD's own service directly (service-to-service, not through the BFF) once a
// component set's CAD file path is set. Fire-and-forget notification — no file bytes pass
// through Visualization. Resolves which image_request(s) are waiting on this componentSetId
// and creates a `zb` task for each matching request that doesn't already have one; zero matches
// is a valid no-op. Idempotent — retrying for a componentSetId that already has a `zb` task for
// a given request just skips it.
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

  const model = getEntityModel();
  const detailsField = getDetailsField();

  return executeOperation(
    async () => {
      // No Sequelize model for image_request in this repo — read/written via raw parameterized
      // SQL against the shared pim_local table, same treatment as component_set.
      const matchingRequests = await defaultSequelize.query(
        `SELECT image_request_id, image_request_details, status, api_version
         FROM image_request
         WHERE image_request_details->'requestedVariants' @> :variant::jsonb`,
        { replacements: { variant: JSON.stringify([{ componentSetId }]) }, type: defaultSequelize.QueryTypes.SELECT }
      );

      const createdFor = [];
      const alreadyExistedFor = [];

      for (const req of matchingRequests) {
        const details = req.image_request_details || {};
        const variant = (details.requestedVariants || []).find(v => v.componentSetId === componentSetId);
        if (!variant) continue; // shouldn't happen given the containment match above, but don't trust it blindly

        // Builds a new array rather than mutating `details` in place, so the history row below
        // still captures the pre-update state.
        const updatedRequestedVariants = (details.requestedVariants || []).map(v =>
          v.componentSetId === componentSetId && v.cadFilePath !== cadFilePath
            ? { ...v, cadFilePath }
            : v
        );
        if (!_.isEqual(updatedRequestedVariants, details.requestedVariants)) {
          await defaultSequelize.query(
            `INSERT INTO image_request_history
               (image_request_id, image_request_details, updated_fields, status, api_version, created_at, updated_at)
             VALUES (:id, :details::jsonb, :updatedFields::jsonb, :status, :apiVersion, NOW(), NOW())`,
            {
              replacements: {
                id: req.image_request_id,
                details: JSON.stringify(details),
                updatedFields: JSON.stringify(['requestedVariants']),
                status: req.status,
                apiVersion: req.api_version,
              },
              type: defaultSequelize.QueryTypes.INSERT,
            }
          );
          await defaultSequelize.query(
            `UPDATE image_request SET image_request_details = :newDetails::jsonb, updated_at = NOW()
             WHERE image_request_id = :id`,
            {
              replacements: {
                id: req.image_request_id,
                newDetails: JSON.stringify({ ...details, requestedVariants: updatedRequestedVariants }),
              },
              type: defaultSequelize.QueryTypes.UPDATE,
            }
          );
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

// --------------------
// POST /:id/images — appends uploaded image URLs to this task's `uploadedImages`. Render (rn)
// stage only. Not routed through the generic update(): lodash _.merge merges arrays index-by-index
// rather than appending, which would corrupt this list on a second upload. Validates before
// executeOperation() for the same reason as performAction.
// --------------------
async function addUploadedImages(id, imageUrls, logContext = {}) {
  const model = getEntityModel();
  const historyModel = getEntityHistoryModel();
  const idField = getEntityIdField();
  const detailsField = getDetailsField();

  if (!Array.isArray(imageUrls) || imageUrls.length === 0 || imageUrls.some(u => typeof u !== 'string' || !u)) {
    throw badRequest('imageUrls must be a non-empty array of URL strings');
  }

  const entity = await model.findOne({ where: { [idField]: id } });
  if (!entity) return { status: 404, data: null };

  const details = entity[detailsField] || {};
  if (details.stage !== 'rn') {
    throw badRequest(`Images can only be uploaded for the render (rn) stage, not '${details.stage}'`);
  }

  const existing = Array.isArray(details.uploadedImages) ? details.uploadedImages : [];
  const newDetails = { ...details, uploadedImages: [...existing, ...imageUrls] };

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

      await entity.update({ [detailsField]: newDetails, api_version: version });

      logger.debug({
        message: `AddUploadedImages_${entityName}: added ${imageUrls.length} image(s) (now ${newDetails.uploadedImages.length} total)`,
        messageType: 'EVENT',
        processName: logContext.processName || `AddUploadedImages_${entityName}`,
        correlationId: logContext.correlationId,
        metadata: { entityName, entityId: id, addedCount: imageUrls.length },
      });

      return entity;
    },
    {
      processName: logContext.processName || `AddUploadedImages_${entityName}`,
      correlationId: logContext.correlationId,
      metadata: { entityName, entityId: id },
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
  addUploadedImages,
};
