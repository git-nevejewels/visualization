// src/entities/base_design/v1/controllers/entityController.js
// Read-only, molded from Merchandising's base_design API + our own component_set/image_request
// data into Visualization's own response shape — see services/entityService.js.

const entityService = require('../services/entityService');

async function getAll(req, res, next) {
  const { correlationId } = req.correlationContext || {};
  try {
    const page = parseInt(req.query.pageNumber, 10) || 1;
    const pageSize = parseInt(req.query.batchSize, 10) || 20;
    const search = req.query.search || '';
    const result = await entityService.getAll(page, pageSize, search, { correlationId, processName: 'GetAll_base_design' });
    return res.status(result.status).json({
      status: result.status,
      data: result.data?.rows || [],
      pagination: { batchSize: pageSize, pageNo: page, totalCount: result.data?.count || 0 },
    });
  } catch (error) { next(error); }
}

async function getById(req, res, next) {
  const { correlationId } = req.correlationContext || {};
  try {
    const result = await entityService.getById(req.params.id, { correlationId, processName: 'GetById_base_design' });
    if (!result.data) return res.status(result.status || 404).json({ status: result.status || 404, error: 'base_design not found', correlationId });
    return res.status(result.status).json({ status: result.status, data: result.data });
  } catch (error) { next(error); }
}

async function getOptions(req, res, next) {
  const { correlationId } = req.correlationContext || {};
  try {
    const { stoneTeamId, metalSelections: metalSelectionsRaw } = req.query;

    let metalSelections;
    if (metalSelectionsRaw !== undefined) {
      try {
        metalSelections = JSON.parse(metalSelectionsRaw);
      } catch {
        return res.status(400).json({ status: 400, error: 'metalSelections must be valid JSON, e.g. {"Band Width":"01","Ring Size":"06"}', correlationId });
      }
    }

    const result = await entityService.getOptions(req.params.id, { stoneTeamId, metalSelections }, { correlationId, processName: 'GetOptions_base_design' });
    if (!result.data) {
      const message = stoneTeamId
        ? `base_design not found, has no component_set variants yet, or no stone team matches stoneTeamId=${stoneTeamId}`
        : 'base_design not found, or has no component_set variants yet';
      return res.status(result.status || 404).json({ status: result.status || 404, error: message, correlationId });
    }
    return res.status(result.status).json({ status: result.status, data: result.data });
  } catch (error) { next(error); }
}

async function matchComponentSet(req, res, next) {
  const { correlationId } = req.correlationContext || {};
  try {
    const { metalTeamCode, stoneTeamCode, caratValue } = req.query;
    const result = await entityService.matchComponentSet(req.params.id, { metalTeamCode, stoneTeamCode, caratValue },
      { correlationId, processName: 'MatchComponentSet_base_design' });
    if (!result.data) {
      return res.status(result.status || 404).json({
        status: result.status || 404,
        error: `No component_set matches metalTeamCode=${metalTeamCode}/stoneTeamCode=${stoneTeamCode}${caratValue !== undefined ? `/caratValue=${caratValue}` : ''} for base_design ${req.params.id}`,
        correlationId,
      });
    }
    return res.status(result.status).json({ status: result.status, data: result.data });
  } catch (error) {
    if (error.status === 400) {
      return res.status(400).json({ status: 400, error: error.message, correlationId });
    }
    next(error);
  }
}

module.exports = { getAll, getById, getOptions, matchComponentSet };
