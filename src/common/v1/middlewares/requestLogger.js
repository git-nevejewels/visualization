// src/common/v1/middlewares/requestLogger.js
// Logs REQUEST and RESPONSE for every inbound API call.
// Includes sessionId and transactionId from correlationContext.

const logger = require('../utils/logger');

function requestLoggerMiddleware(req, res, next) {
  const startTime = Date.now();
  const { correlationId, sessionId, transactionId, traceId, spanId } = req.correlationContext || {};
  const processName = deriveProcessName(req);
  const userId = req.headers['x-user-id'] || req.user?.email || undefined;

  // LOG REQUEST
  logger.info({
    message: `${req.method} ${req.originalUrl} - request received`,
    messageType: 'REQUEST',
    processName,
    correlationId,
    sessionId,
    transactionId,
    traceId,
    spanId,
    userId,
    entityName: req.entityContext?.entityName,
    httpMethod: req.method,
    httpPath: req.originalUrl,
    headers: req.headers,
    payload: req.body && Object.keys(req.body).length > 0 ? req.body : undefined,
  });

  // Intercept response
  const originalJson = res.json.bind(res);
  res.json = function (body) {
    const durationMs = Date.now() - startTime;

    logger.info({
      message: `${req.method} ${req.originalUrl} - response sent (${res.statusCode})`,
      messageType: 'RESPONSE',
      processName,
      correlationId,
      sessionId,
      transactionId,
      traceId,
      spanId,
      userId,
      entityName: req.entityContext?.entityName,
      httpMethod: req.method,
      httpPath: req.originalUrl,
      httpStatusCode: res.statusCode,
      durationMs,
      headers: res.getHeaders ? res.getHeaders() : undefined,
      payload: body,
    });

    return originalJson(body);
  };

  next();
}

function deriveProcessName(req) {
  const method = req.method.toUpperCase();
  const entity = req.entityContext?.entityName || 'Unknown';
  const parts = req.originalUrl.split('/').filter(Boolean);
  const lastPart = parts[parts.length - 1];

  if (lastPart === 'create') return `Create${cap(entity)}`;
  if (lastPart === 'bulkCreate') return `BulkCreate${cap(entity)}`;
  if (method === 'GET' && req.params?.id) return `Get${cap(entity)}ById`;
  if (method === 'GET') return `GetAll${cap(entity)}`;
  if (method === 'PUT' || method === 'PATCH') return `Update${cap(entity)}`;
  if (method === 'DELETE') return `Delete${cap(entity)}`;
  return `${method}_${entity}`;
}

function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; }

module.exports = requestLoggerMiddleware;
