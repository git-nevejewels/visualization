// src/entities/image_request/v1/services/entityService.js
const Joi = require('joi');
const { Sequelize, Op } = require('sequelize');
const _ = require('lodash');
const path = require('path');
const logger = require('../../../../common/v1/utils/logger');
const mainConfig = require('../../../../../config/config');
const { fetchJson, putJson } = require('../../../../common/v1/utils/httpClient');

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
// reach into it, e.g. {"image_request_details.baseDesignId": "..."} or the
// equivalent nested form {"image_request_details": {"baseDesignId": "..."}}
// — a bare {"baseDesignId": "..."} is treated as a literal top-level
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
// Accepts an OPTIONAL `requestedVariants` array directly at creation time — mirrors the real
// wireframe's own submitReq(), which raises one request for an ENTIRE basket of already-matched
// variants in one action, not a create() followed by N separate POST /:id/variants calls (added
// 2026-09-16 — see GAPS.md). Each entry gets the SAME validation `addRequestedVariant` already
// applies to a single append (`validateRequestedVariant`), plus a dedup check against every OTHER
// entry in this same array (there's no "existing" request yet to dedupe against) — same rule:
// same componentSetId + same colour sets is a duplicate. Validated BEFORE executeOperation, per
// this repo's own established pattern (queryExecutor.js discards a custom `.status` on any error
// it doesn't recognize).
function validateRequestedVariantsArray(requestedVariants) {
  for (const variant of requestedVariants) validateRequestedVariant(variant);

  const seen = [];
  for (const variant of requestedVariants) {
    const isDuplicate = seen.some(v =>
      v.componentSetId === variant.componentSetId &&
      _.isEqual([...v.metalColourGroups].sort(), [...variant.metalColourGroups].sort()) &&
      _.isEqual([...v.stoneColours].sort(), [...variant.stoneColours].sort())
    );
    if (isDuplicate) {
      throw badRequest(`Duplicate variant in requestedVariants (componentSetId '${variant.componentSetId}' with the same colours)`);
    }
    seen.push(variant);
  }
}

// --------------------
// Visualization -> CAD notification — see ARCHITECTURE.md's "CAD <-> Visualization integration".
// Fires once per requestedVariant right after a NEW image_request is created (only trigger point
// for now, per manager's confirmation still pending on the "add to an existing open request" case
// — see GAPS.md). Reuses CAD's own existing generic update() endpoint (PUT /api/component_set/v1/
// update/:id) directly, no new API needed on CAD's side. Best-effort, fire-and-forget — mirrors the
// same direct-call reliability tradeoff already accepted for the CAD -> Visualization direction:
// a failed notification is logged and swallowed, never allowed to fail or delay create()'s own
// response.
// --------------------
function cadComponentSetUpdateUrl(componentSetId) {
  if (!mainConfig.urls.cad) {
    throw new Error('CAD url is not configured (see .env / config/config.js urls.cad)');
  }
  return `${mainConfig.urls.cad}/api/component_set/v1/update/${componentSetId}`;
}

async function notifyCadOfRequestedVariants(requestedVariants, logContext = {}) {
  const requestedAt = new Date().toISOString();
  await Promise.all(requestedVariants.map(async (variant) => {
    try {
      await putJson(cadComponentSetUpdateUrl(variant.componentSetId), {
        component_set_details: {
          visualizationRequested: true,
          visualizationRequestedAt: requestedAt,
        },
      });
    } catch (err) {
      logger.error({
        message: `NotifyCad_${entityName}: failed to notify CAD for componentSetId '${variant.componentSetId}': ${err.message}`,
        messageType: 'EVENT',
        processName: logContext.processName || `NotifyCad_${entityName}`,
        correlationId: logContext.correlationId,
        metadata: { entityName, componentSetId: variant.componentSetId },
      });
    }
  }));
}

async function create(data, logContext = {}) {
  const model = getEntityModel();
  const detailsField = getDetailsField();

  const details = data[detailsField] || data;
  const requestedVariants = Array.isArray(details.requestedVariants) ? details.requestedVariants : [];
  if (requestedVariants.length > 0) validateRequestedVariantsArray(requestedVariants);

  const result = await executeOperation(
    () =>
      model.create({
        [detailsField]: details,
        created_by: data.created_by,
        updated_by: data.updated_by,
        api_version: version,
        status: data.status,
      }),
    {
      processName: logContext.processName || `Create_${entityName}`,
      correlationId: logContext.correlationId,
      metadata: { entityName, version },
    }
  );

  if (result.status >= 200 && result.status < 300 && requestedVariants.length > 0) {
    notifyCadOfRequestedVariants(requestedVariants, logContext).catch(() => {});
  }

  return result;
}

async function bulkCreate(dataArray, logContext = {}) {
  const model = getEntityModel();
  const idField = getEntityIdField();
  const detailsField = getDetailsField();

  return executeOperation(
    () =>
      model.bulkCreate(
        dataArray.map(d => ({
          [idField]: d[idField],
          [detailsField]: d[detailsField] || d,
          created_by: d.created_by,
          updated_by: d.updated_by,
          api_version: version,
          status: d.status,
        }))
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
// requestedVariants — see ARCHITECTURE.md/GAPS.md/RULES.md's "Cross-service triggers" section.
// Appends one variant to image_request_details.requestedVariants. Deliberately NOT implemented
// via the generic update() — lodash _.merge (used there) merges arrays index-by-index rather than
// appending, which would silently corrupt this list on a second add. Same validate-before-
// executeOperation() pattern as variant_task's performAction(), for the same reason: a thrown
// error's custom `.status` would otherwise be discarded by queryExecutor.js's catch-all.
// --------------------
const REQUESTED_VARIANT_REQUIRED_FIELDS = [
  'componentSetId', 'metalTeamId', 'metalTeamCode', 'stoneTeamId', 'stoneTeamCode',
  'dimensionalSelection', 'metalColourGroups', 'stoneColours',
];

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

function validateRequestedVariant(variant) {
  if (!variant || typeof variant !== 'object') {
    throw badRequest('variant must be an object');
  }
  const missing = REQUESTED_VARIANT_REQUIRED_FIELDS.filter(f => variant[f] === undefined || variant[f] === null);
  if (missing.length > 0) {
    throw badRequest(`variant is missing required field(s): ${missing.join(', ')}`);
  }
  if (!Array.isArray(variant.metalColourGroups) || variant.metalColourGroups.length === 0) {
    throw badRequest('variant.metalColourGroups must be a non-empty array');
  }
  if (!Array.isArray(variant.stoneColours) || variant.stoneColours.length === 0) {
    throw badRequest('variant.stoneColours must be a non-empty array');
  }
}

async function addRequestedVariant(id, variant, logContext = {}) {
  const model = getEntityModel();
  const historyModel = getEntityHistoryModel();
  const idField = getEntityIdField();
  const detailsField = getDetailsField();

  validateRequestedVariant(variant);

  const entity = await model.findOne({ where: { [idField]: id } });
  if (!entity) return { status: 404, data: null };

  const details = entity[detailsField] || {};
  const existing = Array.isArray(details.requestedVariants) ? details.requestedVariants : [];

  const isDuplicate = existing.some(v =>
    v.componentSetId === variant.componentSetId &&
    _.isEqual([...v.metalColourGroups].sort(), [...variant.metalColourGroups].sort()) &&
    _.isEqual([...v.stoneColours].sort(), [...variant.stoneColours].sort())
  );
  if (isDuplicate) {
    throw badRequest(`This variant (componentSetId '${variant.componentSetId}' with the same colours) is already in this request`);
  }

  const newDetails = { ...details, requestedVariants: [...existing, variant] };

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
        api_version: version,
      });

      logger.debug({
        message: `AddRequestedVariant_${entityName}: added componentSetId '${variant.componentSetId}' (now ${newDetails.requestedVariants.length} variant(s))`,
        messageType: 'EVENT',
        processName: logContext.processName || `AddRequestedVariant_${entityName}`,
        correlationId: logContext.correlationId,
        metadata: { entityName, entityId: id, componentSetId: variant.componentSetId },
      });

      return entity;
    },
    {
      processName: logContext.processName || `AddRequestedVariant_${entityName}`,
      correlationId: logContext.correlationId,
      metadata: { entityName, entityId: id },
    }
  );
}

// --------------------
// Request-level rollups — see ARCHITECTURE.md's "Raising & managing requests" API surface.
// None of this is stored (per RULES.md's "never store a computed rollup" principle) — always
// derived by reading variant_task rows for the requestedVariants recorded on this image_request.
// --------------------
const STAGE_ORDER = ['zb', 'obj', 'rn'];

const getVariantTaskModel = () => {
  const model = defaultSequelize.models['variant_task'];
  if (!model) throw new Error('Model not loaded: variant_task');
  return model;
};

// tasksForVariant: every variant_task row found for this (imageRequestId, componentSetId) pair —
// 0 to 3 of them. By construction (see variant_task's RULES.md), if a later stage's task exists,
// every earlier stage's task exists too and is Completed — so the first non-Completed stage found
// in STAGE_ORDER is always "where this variant currently is."
function summarizeVariant(requestedVariant, tasksForVariant) {
  const byStage = {};
  for (const t of tasksForVariant) {
    const d = t.variant_task_details || {};
    byStage[d.stage] = { variant_task_id: t.variant_task_id, status: d.status, assignee: d.assignee || null };
  }

  const imageSets = (requestedVariant.metalColourGroups?.length || 0) * (requestedVariant.stoneColours?.length || 0);

  let currentStage = null;
  let currentStatus = 'Awaiting CAD'; // no zb task yet — FG CAD not confirmed for this variant
  for (const stage of STAGE_ORDER) {
    const entry = byStage[stage];
    if (!entry) break;
    if (entry.status !== 'Completed') {
      currentStage = stage;
      currentStatus = entry.status;
      break;
    }
    if (stage === 'rn') currentStatus = 'Delivered';
  }

  return {
    componentSetId: requestedVariant.componentSetId,
    metalTeamId: requestedVariant.metalTeamId,
    metalTeamCode: requestedVariant.metalTeamCode,
    stoneTeamId: requestedVariant.stoneTeamId,
    stoneTeamCode: requestedVariant.stoneTeamCode,
    dimensionalSelection: requestedVariant.dimensionalSelection,
    metalColourGroups: requestedVariant.metalColourGroups,
    stoneColours: requestedVariant.stoneColours,
    imageSets,
    stages: { zb: byStage.zb || null, obj: byStage.obj || null, rn: byStage.rn || null },
    currentStage,
    currentStatus,
  };
}

// --------------------
// base_design display info (ornamentName/collectionNumber/collectionPrefix) — Merchandising owns
// base_design for real (see base_design's own entityService.js/RULES.md); image_request only ever
// stores a bare `baseDesignId` reference (see entitySchema.json), never a display name or
// collection number. The "Manage visualization requests" dashboard table needs both, so this fetches
// them by id, same call base_design's own module makes. NOT reusing base_design's own
// fetchAllBaseDesigns() cache directly — cross-entity service imports have no precedent in this
// codebase and would couple two otherwise-independent entity modules; a small per-id cache here
// (same plain-TTL pattern as base_design's own stone_template cache) is simpler and just as cheap,
// since only the handful of distinct baseDesignIds actually referenced by open requests are ever
// fetched, not the whole ~1,100-row catalog.
// --------------------
function merchandisingUrl(path) {
  if (!mainConfig.urls.merchandising) {
    throw new Error('MERCHANDISING url is not configured (see .env / config/config.js urls.merchandising)');
  }
  return `${mainConfig.urls.merchandising}/api/base_design/v1${path}`;
}

const BASE_DESIGN_DISPLAY_CACHE_TTL_MS = 5 * 60_000;
const baseDesignDisplayCache = new Map(); // baseDesignId -> { data, fetchedAt }

async function fetchBaseDesignDisplayInfo(baseDesignId) {
  const cached = baseDesignDisplayCache.get(baseDesignId);
  if (cached && (Date.now() - cached.fetchedAt) < BASE_DESIGN_DISPLAY_CACHE_TTL_MS) return cached.data;

  let body;
  try {
    body = await fetchJson(merchandisingUrl(`/${baseDesignId}`));
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
  const basicInformation = body.data?.base_design_details?.basicInformation || {};
  const data = {
    ornamentName: basicInformation.ornamentName,
    collectionNumber: basicInformation.collectionNumber,
    collectionPrefix: basicInformation.collectionPrefix,
  };
  baseDesignDisplayCache.set(baseDesignId, { data, fetchedAt: Date.now() });
  return data;
}

// One request-level rollup for the "Manage visualization requests" dashboard table — scope
// (variant/image-set counts), per-stage cumulative progress, and the current stage/status
// distribution across all of a request's variants. All derived from summarizeVariant() above,
// never stored (same "never store a computed rollup" principle as everywhere else in this file).
//
// stageProgress[stage] counts variants that have COMPLETED that stage (i.e. moved past it) — e.g.
// zb.done counts variants currently at obj, rn, or Delivered. whereItIsNow counts variants by
// where they CURRENTLY sit (their first non-Completed stage, or Delivered, or no task yet at all).
// Verified these two views are consistent by construction: zb.done = obj-count + rn-count +
// delivered-count (every variant not currently AT zb has necessarily completed it).
function summarizeRequestRollup(requestedVariants, tasksByComponentSetId) {
  const variantSummaries = requestedVariants.map(rv =>
    summarizeVariant(rv, tasksByComponentSetId[rv.componentSetId] || []));

  const variantCount = variantSummaries.length;
  const imageSetCount = variantSummaries.reduce((sum, v) => sum + v.imageSets, 0);

  const whereItIsNow = { zb: 0, obj: 0, rn: 0, delivered: 0, awaitingCad: 0 };
  for (const v of variantSummaries) {
    if (v.currentStatus === 'Delivered') whereItIsNow.delivered++;
    else if (v.currentStage) whereItIsNow[v.currentStage]++;
    else whereItIsNow.awaitingCad++; // no variant_task row yet — FG CAD not confirmed
  }

  const stageProgress = {
    zb: { done: whereItIsNow.obj + whereItIsNow.rn + whereItIsNow.delivered, total: variantCount },
    obj: { done: whereItIsNow.rn + whereItIsNow.delivered, total: variantCount },
    rn: { done: whereItIsNow.delivered, total: variantCount },
  };

  return {
    variantCount,
    imageSetCount,
    stageProgress,
    whereItIsNow,
    variantsDoneCount: whereItIsNow.delivered,
  };
}

// GET /:id/variants — one row per requestedVariant, with its current stage/status.
async function getVariantsDetail(id, logContext = {}) {
  const model = getEntityModel();
  const idField = getEntityIdField();
  const detailsField = getDetailsField();

  return executeOperation(
    async () => {
      const entity = await model.findOne({ where: { [idField]: id } });
      if (!entity) return null;

      const details = entity[detailsField] || {};
      const requestedVariants = Array.isArray(details.requestedVariants) ? details.requestedVariants : [];

      const taskModel = getVariantTaskModel();
      const allTasks = await taskModel.findAll({ where: { 'variant_task_details.imageRequestId': id } });

      const tasksByComponentSetId = {};
      for (const t of allTasks) {
        const csid = t.variant_task_details?.componentSetId;
        if (!csid) continue;
        (tasksByComponentSetId[csid] = tasksByComponentSetId[csid] || []).push(t);
      }

      const variants = requestedVariants.map(rv => summarizeVariant(rv, tasksByComponentSetId[rv.componentSetId] || []));

      return { imageRequest: entity, variants };
    },
    {
      processName: logContext.processName || `GetVariantsDetail_${entityName}`,
      correlationId: logContext.correlationId,
      metadata: { entityName, entityId: id },
    }
  );
}

// GET /dashboard — overview KPIs across every image_request.
async function getDashboard(logContext = {}) {
  const model = getEntityModel();
  const idField = getEntityIdField();
  const detailsField = getDetailsField();
  const taskModel = getVariantTaskModel();

  return executeOperation(
    async () => {
      const allRequests = await model.findAll();
      const allTasks = await taskModel.findAll();

      const tasksByKey = {};
      for (const t of allTasks) {
        const d = t.variant_task_details || {};
        const key = `${d.imageRequestId}::${d.componentSetId}`;
        (tasksByKey[key] = tasksByKey[key] || []).push(t);
      }

      let openRequests = 0, rushRequests = 0, variantsInFlight = 0, variantsDelivered = 0, imageSetsOrdered = 0;
      const unassignedTasks = allTasks.filter(t => (t.variant_task_details || {}).status === 'Ready').length;

      for (const req of allRequests) {
        const d = req[detailsField] || {};
        const requestedVariants = Array.isArray(d.requestedVariants) ? d.requestedVariants : [];
        if (d.priority === 'Rush') rushRequests++;

        let fullyDelivered = requestedVariants.length > 0;
        for (const rv of requestedVariants) {
          const tasks = tasksByKey[`${req[idField]}::${rv.componentSetId}`] || [];
          const summary = summarizeVariant(rv, tasks);
          imageSetsOrdered += summary.imageSets;
          if (summary.currentStatus === 'Delivered') variantsDelivered++;
          else { variantsInFlight++; fullyDelivered = false; }
        }
        if (!fullyDelivered) openRequests++;
      }

      return { openRequests, variantsInFlight, variantsDelivered, imageSetsOrdered, rushRequests, unassignedTasks };
    },
    {
      processName: logContext.processName || `GetDashboard_${entityName}`,
      correlationId: logContext.correlationId,
      metadata: { entityName },
    }
  );
}

// GET /getByStats?statsStatus=open|delivered|rush — mirrors design_request's own getByStats
// pattern (validate + throw BEFORE executeOperation, same reasoning as variant_task's
// performAction: queryExecutor.js discards a custom `.status` on any error it doesn't recognize).
// 'open'/'delivered' require a per-request rollup across variant_task, which a plain filterQuery
// can't express — computed here in JS rather than SQL, same tradeoff the original wireframe made.
const VALID_STATS = ['open', 'delivered', 'rush'];

async function getByStats(statsStatus, page = 1, pageSize = 20, logContext = {}) {
  if (!VALID_STATS.includes(statsStatus)) {
    const err = new Error(`Invalid statsStatus '${statsStatus}'. Must be one of: ${VALID_STATS.join(', ')}`);
    err.status = 400;
    throw err;
  }

  const model = getEntityModel();
  const idField = getEntityIdField();
  const detailsField = getDetailsField();
  const taskModel = getVariantTaskModel();

  return executeOperation(
    async () => {
      const allRequests = await model.findAll();
      const allTasks = await taskModel.findAll();

      const tasksByKey = {};
      for (const t of allTasks) {
        const d = t.variant_task_details || {};
        const key = `${d.imageRequestId}::${d.componentSetId}`;
        (tasksByKey[key] = tasksByKey[key] || []).push(t);
      }

      const matched = allRequests.filter(req => {
        const d = req[detailsField] || {};
        if (statsStatus === 'rush') return d.priority === 'Rush';

        const requestedVariants = Array.isArray(d.requestedVariants) ? d.requestedVariants : [];
        const delivered = requestedVariants.length > 0 && requestedVariants.every(rv => {
          const tasks = tasksByKey[`${req[idField]}::${rv.componentSetId}`] || [];
          return summarizeVariant(rv, tasks).currentStatus === 'Delivered';
        });

        return statsStatus === 'delivered' ? delivered : !delivered;
      });

      const count = matched.length;
      const pageRequests = matched.slice((page - 1) * pageSize, (page - 1) * pageSize + pageSize);

      // Molded rows for the "Manage visualization requests" dashboard table — scope/stage
      // progress/current-status distribution (see summarizeRequestRollup) plus base_design display
      // info (ornamentName/collectionNumber/collectionPrefix — image_request itself only ever
      // stores a bare baseDesignId reference, never a display name). Only the current page is
      // molded/enriched, same principle as base_design's own getAll (see RULES.md) — no reason to
      // pay for a Merchandising round trip or a rollup computation for rows nobody's looking at.
      const rows = await Promise.all(pageRequests.map(async req => {
        const d = req[detailsField] || {};
        const requestedVariants = Array.isArray(d.requestedVariants) ? d.requestedVariants : [];

        const tasksByComponentSetId = {};
        for (const rv of requestedVariants) {
          tasksByComponentSetId[rv.componentSetId] = tasksByKey[`${req[idField]}::${rv.componentSetId}`] || [];
        }
        const rollup = summarizeRequestRollup(requestedVariants, tasksByComponentSetId);
        const displayInfo = d.baseDesignId ? await fetchBaseDesignDisplayInfo(d.baseDesignId) : null;

        return {
          imageRequestId: req[idField],
          baseDesignId: d.baseDesignId,
          ornamentName: displayInfo?.ornamentName,
          collectionNumber: displayInfo?.collectionNumber,
          collectionPrefix: displayInfo?.collectionPrefix,
          requestedBy: d.requestedBy,
          neededBy: d.neededBy,
          priority: d.priority,
          status: d.status,
          scope: { variantCount: rollup.variantCount, imageSetCount: rollup.imageSetCount },
          stageProgress: rollup.stageProgress,
          whereItIsNow: rollup.whereItIsNow,
          variantsDoneCount: rollup.variantsDoneCount,
        };
      }));

      return { rows, count };
    },
    {
      processName: logContext.processName || `GetByStats_${entityName}`,
      correlationId: logContext.correlationId,
      metadata: { entityName, statsStatus, page, pageSize },
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
  addRequestedVariant,
  getVariantsDetail,
  getDashboard,
  getByStats,
};
