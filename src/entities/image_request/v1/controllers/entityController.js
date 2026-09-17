// controllers/entityController.js
// After every successful CRUD operation, publishes a domain event to
// neve-jewels-workflow-inbox for the Workflow Manager to evaluate.

const path = require('path');
const entityService = require('../services/entityService');
const logger = require('../../../../common/v1/utils/logger');
const { publishDomainEvent } = require('../../../../common/v1/utils/domainEventPublisher');

// Auto-detect entity name and version from folder structure
const version = path.basename(path.dirname(__dirname));
const entityName = path.basename(path.join(__dirname, '..', '..'));

async function create(req, res, next) {
  const { correlationId, traceId, spanId } = req.correlationContext || {};
  const userId = req.headers['x-user-id'] || req.user?.email;
  try {
    const data = await entityService.create(req.body, { correlationId, processName: `Create_${entityName}` });

    if (data.status >= 200 && data.status < 300 && data.data) {
      await publishDomainEvent(entityName, 'created', version, data.data.toJSON ? data.data.toJSON() : data.data,
        { correlationId, traceId, spanId, userId });
    }

    return res.status(data.status).json({ status: data.status, data: data.data });
  } catch (error) { next(error); }
}

async function bulkCreate(req, res, next) {
  const { correlationId, traceId, spanId } = req.correlationContext || {};
  const userId = req.headers['x-user-id'] || req.user?.email;
  try {
    const data = await entityService.bulkCreate(req.body, { correlationId, processName: `BulkCreate_${entityName}` });

    if (data.status >= 200 && data.status < 300 && data.data) {
      const records = Array.isArray(data.data) ? data.data : [data.data];
      for (const record of records) {
        await publishDomainEvent(entityName, 'created', version, record.toJSON ? record.toJSON() : record,
          { correlationId, traceId, spanId, userId });
      }
    }

    return res.status(data.status).json({ status: data.status, data: data.data });
  } catch (error) { next(error); }
}

async function getById(req, res, next) {
  const { correlationId } = req.correlationContext || {};
  try {
    const entityId = req.params.id;
    const { fields = '', filterQuery = '{}' } = req.query;
    let parsedFilterQuery = {};
    try { parsedFilterQuery = JSON.parse(filterQuery); } catch { return res.status(400).json({ error: 'Invalid filterQuery' }); }
    const entity = await entityService.getById(entityId, fields, parsedFilterQuery, { correlationId, processName: `GetById_${entityName}` });
    if (!entity) return res.status(404).json({ message: 'Entity not found' });
    return res.status(entity.status).json({ status: entity.status, data: entity.data });
  } catch (error) { next(error); }
}

async function getAll(req, res, next) {
  const { correlationId } = req.correlationContext || {};
  try {
    const page = parseInt(req.query.pageNumber, 10) || 1;
    const pageSize = parseInt(req.query.batchSize, 10) || 10;
    const fields = req.query.fields || '';
    let filterQuery = {}; if (req.query.filterQuery) { try { filterQuery = JSON.parse(req.query.filterQuery); } catch { return res.status(400).json({ error: 'Invalid filterQuery' }); } }
    let searchQuery = {}; if (req.query.search) { try { searchQuery = JSON.parse(req.query.search); } catch { return res.status(400).json({ error: 'Invalid search' }); } }
    const result = await entityService.getAll(page, pageSize, filterQuery, fields, searchQuery, { correlationId, processName: `GetAll_${entityName}` });
    return res.status(result.status).json({ status: result.status, data: result.data?.rows || [], pagination: { batchSize: pageSize, pageNo: page, totalCount: result.data?.count || 0 } });
  } catch (error) { next(error); }
}

async function update(req, res, next) {
  const { correlationId, traceId, spanId } = req.correlationContext || {};
  const userId = req.headers['x-user-id'] || req.user?.email;
  try {
    const entityId = req.params.id;
    const updatedEntity = await entityService.update(entityId, req.body, { correlationId, processName: `Update_${entityName}` });

    if (updatedEntity.status >= 200 && updatedEntity.status < 300 && updatedEntity.data) {
      await publishDomainEvent(entityName, 'updated', version, updatedEntity.data.toJSON ? updatedEntity.data.toJSON() : updatedEntity.data,
        { correlationId, traceId, spanId, userId });
    }

    return res.status(updatedEntity.status).json({ status: updatedEntity.status, data: updatedEntity.data });
  } catch (error) { next(error); }
}

async function deleteEntity(req, res, next) {
  const { correlationId, traceId, spanId } = req.correlationContext || {};
  const userId = req.headers['x-user-id'] || req.user?.email;
  try {
    const entityId = req.params.id;
    const result = await entityService.deleteEntity(entityId, { correlationId, processName: `Delete_${entityName}` });

    await publishDomainEvent(entityName, 'deleted', version, { entityId },
      { correlationId, traceId, spanId, userId });

    return res.status(200).json({ status: 200, message: 'Entity deleted successfully' });
  } catch (error) { next(error); }
}

// --------------------
// requestedVariants — see ARCHITECTURE.md/RULES.md. Same error-status handling as variant_task's
// performAction: a service-thrown `error.status === 400` (missing field, duplicate variant)
// surfaces as a proper 400 instead of falling through to the global error handler as a 500.
// --------------------
async function addRequestedVariant(req, res, next) {
  const { correlationId, traceId, spanId } = req.correlationContext || {};
  const userId = req.headers['x-user-id'] || req.user?.email;
  try {
    const entityId = req.params.id;
    const result = await entityService.addRequestedVariant(entityId, req.body,
      { correlationId, processName: `AddRequestedVariant_${entityName}` });

    if (!result.data) {
      return res.status(result.status || 404).json({ status: 'error', message: 'Entity not found', correlationId });
    }

    await publishDomainEvent(entityName, 'updated', version, result.data.toJSON ? result.data.toJSON() : result.data,
      { correlationId, traceId, spanId, userId });

    return res.status(result.status).json({ status: result.status, data: result.data });
  } catch (error) {
    if (error.status === 400) {
      return res.status(400).json({ status: 'error', message: error.message, correlationId });
    }
    next(error);
  }
}

// --------------------
// Request-level rollups — see ARCHITECTURE.md/RULES.md.
// --------------------
async function getVariantsDetail(req, res, next) {
  const { correlationId } = req.correlationContext || {};
  try {
    const result = await entityService.getVariantsDetail(req.params.id, { correlationId, processName: `GetVariantsDetail_${entityName}` });
    if (!result.data) return res.status(result.status || 404).json({ status: 'error', message: 'Entity not found', correlationId });
    return res.status(result.status).json({ status: result.status, data: result.data });
  } catch (error) { next(error); }
}

async function getDashboard(req, res, next) {
  const { correlationId } = req.correlationContext || {};
  try {
    const result = await entityService.getDashboard({ correlationId, processName: `GetDashboard_${entityName}` });
    return res.status(result.status).json({ status: result.status, data: result.data });
  } catch (error) { next(error); }
}

async function getByStats(req, res, next) {
  const { correlationId } = req.correlationContext || {};
  try {
    const statsStatus = req.query.statsStatus;
    if (!statsStatus) {
      return res.status(400).json({ status: 'error', message: 'statsStatus query parameter is required. Valid values: open, delivered, rush', correlationId });
    }

    const page = parseInt(req.query.pageNumber, 10) || 1;
    const pageSize = parseInt(req.query.batchSize, 10) || 10;

    const result = await entityService.getByStats(statsStatus, page, pageSize, { correlationId, processName: `GetByStats_${entityName}` });

    return res.status(result.status).json({
      status: result.status,
      data: result.data?.rows || [],
      pagination: { batchSize: pageSize, pageNo: page, totalCount: result.data?.count || 0 },
      filter: { statsStatus },
    });
  } catch (error) {
    if (error.status === 400) {
      return res.status(400).json({ status: 'error', message: error.message, correlationId });
    }
    next(error);
  }
}

async function getPendingCadFiles(req, res, next) {
  const { correlationId } = req.correlationContext || {};
  try {
    const result = await entityService.getPendingCadFiles({ correlationId, processName: `GetPendingCadFiles_${entityName}` });
    return res.status(result.status).json({ status: result.status, data: result.data });
  } catch (error) { next(error); }
}

module.exports = { create, bulkCreate, getById, getAll, update, deleteEntity, addRequestedVariant, getVariantsDetail, getDashboard, getByStats, getPendingCadFiles };
