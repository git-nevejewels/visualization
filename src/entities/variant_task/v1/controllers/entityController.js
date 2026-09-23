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
    try { parsedFilterQuery = JSON.parse(filterQuery); } catch { return res.status(400).json({ status: 400, error: 'Invalid filterQuery', correlationId }); }
    const entity = await entityService.getById(entityId, fields, parsedFilterQuery, { correlationId, processName: `GetById_${entityName}` });
    if (!entity.data) return res.status(entity.status || 404).json({ status: entity.status || 404, error: 'Entity not found', correlationId });
    return res.status(entity.status).json({ status: entity.status, data: entity.data });
  } catch (error) { next(error); }
}

async function getAll(req, res, next) {
  const { correlationId } = req.correlationContext || {};
  try {
    const page = parseInt(req.query.pageNumber, 10) || 1;
    const pageSize = parseInt(req.query.batchSize, 10) || 10;
    const fields = req.query.fields || '';
    let filterQuery = {}; if (req.query.filterQuery) { try { filterQuery = JSON.parse(req.query.filterQuery); } catch { return res.status(400).json({ status: 400, error: 'Invalid filterQuery', correlationId }); } }
    let searchQuery = {}; if (req.query.search) { try { searchQuery = JSON.parse(req.query.search); } catch { return res.status(400).json({ status: 400, error: 'Invalid search', correlationId }); } }
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

// Task workflow actions. A service-thrown `error.status === 400` (illegal state
// transition, or a missing/unknown action) is surfaced as a proper 400 here instead
// of falling through to the global error handler as a 500.
async function performAction(req, res, next) {
  const { correlationId, traceId, spanId } = req.correlationContext || {};
  const userId = req.headers['x-user-id'] || req.user?.email;
  try {
    const entityId = req.params.id;
    const { action, actionBy } = req.body || {};
    if (!action) {
      return res.status(400).json({ status: 400, error: 'action is required', correlationId });
    }

    const result = await entityService.performAction(entityId, action, { actionBy },
      { correlationId, processName: `Action_${entityName}` });

    if (!result.data) {
      return res.status(result.status || 404).json({ status: result.status || 404, error: 'Entity not found', correlationId });
    }

    await publishDomainEvent(entityName, 'updated', version, result.data.toJSON ? result.data.toJSON() : result.data,
      { correlationId, traceId, spanId, userId });

    return res.status(result.status).json({ status: result.status, data: result.data });
  } catch (error) {
    if (error.status === 400) {
      return res.status(400).json({ status: 400, error: error.message, correlationId });
    }
    next(error);
  }
}

async function bulkPerformAction(req, res, next) {
  const { correlationId } = req.correlationContext || {};
  try {
    const { ids, action, actionBy } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ status: 400, error: 'ids must be a non-empty array', correlationId });
    }
    if (!action) {
      return res.status(400).json({ status: 400, error: 'action is required', correlationId });
    }

    const results = await entityService.bulkPerformAction(ids, action, { actionBy },
      { correlationId, processName: `BulkAction_${entityName}` });

    return res.status(200).json({ status: 200, data: results });
  } catch (error) { next(error); }
}

async function handleCadFileUploaded(req, res, next) {
  const { correlationId } = req.correlationContext || {};
  try {
    const { componentSetId, cadFilePath } = req.body || {};
    const result = await entityService.handleCadFileUploaded(componentSetId, cadFilePath,
      { correlationId, processName: `HandleCadFileUploaded_${entityName}` });
    return res.status(result.status).json({ status: result.status, data: result.data });
  } catch (error) {
    if (error.status === 400) {
      return res.status(400).json({ status: 400, error: error.message, correlationId });
    }
    next(error);
  }
}

// POST /:id/images — body carries already-uploaded URLs (an upstream pre-hook converts raw
// bytes to S3/GCS URLs before this is ever called); this endpoint never receives raw file bytes.
async function addUploadedImages(req, res, next) {
  const { correlationId, traceId, spanId } = req.correlationContext || {};
  const userId = req.headers['x-user-id'] || req.user?.email;
  try {
    const entityId = req.params.id;
    const { imageUrls } = req.body || {};
    const result = await entityService.addUploadedImages(entityId, imageUrls,
      { correlationId, processName: `AddUploadedImages_${entityName}` });

    if (!result.data) {
      return res.status(result.status || 404).json({ status: result.status || 404, error: 'Entity not found', correlationId });
    }

    await publishDomainEvent(entityName, 'updated', version, result.data.toJSON ? result.data.toJSON() : result.data,
      { correlationId, traceId, spanId, userId });

    return res.status(result.status).json({ status: result.status, data: result.data });
  } catch (error) {
    if (error.status === 400) {
      return res.status(400).json({ status: 400, error: error.message, correlationId });
    }
    next(error);
  }
}

module.exports = { create, bulkCreate, getById, getAll, update, deleteEntity, performAction, bulkPerformAction, handleCadFileUploaded, addUploadedImages };
