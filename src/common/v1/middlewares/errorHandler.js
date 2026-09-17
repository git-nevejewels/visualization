// src/common/v1/middlewares/errorHandler.js
// Global error handler — implements Section 2.3.4 (Error Log Entry)
// and Section 4.1 (Error Classification).

const logger = require('../utils/logger');
const { classifyError } = require('../utils/errorClassifier');

function errorHandler(err, req, res, next) {
  const { correlationId, sessionId, transactionId, traceId, spanId } = req.correlationContext || {};
  const userId = req.headers['x-user-id'] || req.user?.email || undefined;

  // Classify the error (Section 4.1)
  const classification = classifyError(err);

  // Determine HTTP status
  const statusCode = err.status || err.statusCode || (classification.isRetryable ? 503 : 500);

  // Build the structured error log entry (Section 2.3.4)
  logger.error({
    message: `Error in ${req.method} ${req.originalUrl}: ${err.message}`,
    messageType: 'ERROR',
    processName: deriveProcessName(req),
    correlationId,
    traceId,
    spanId,
    userId,
    httpMethod: req.method,
    httpPath: req.originalUrl,
    httpStatusCode: statusCode,
    durationMs: req._startTime ? Date.now() - req._startTime : undefined,
    error: {
      name: err.name || 'Error',
      message: err.message || 'Internal Server Error',
      stack: err.stack,
      innerError: err.cause?.message || err.innerError || undefined,
      errorCode: classification.errorCode,
      isRetryable: classification.isRetryable,
      type: err.name || 'Error',
    },
    payload: req.body && Object.keys(req.body).length > 0 ? req.body : undefined,
    metadata: {
      entityName: req.entityContext?.entityName,
      version: req.entityContext?.version,
      isRetryable: classification.isRetryable,
    },
  });

  // Send error response
  res.status(statusCode).json({
    status: 'error',
    statusCode,
    message: err.message || 'Internal Server Error',
    errorCode: classification.errorCode,
    isRetryable: classification.isRetryable,
    correlationId,
    traceId,
  });
}

function deriveProcessName(req) {
  const method = req.method.toUpperCase();
  const entity = req.entityContext?.entityName || 'Unknown';
  const parts = req.originalUrl.split('/').filter(Boolean);
  const lastPart = parts[parts.length - 1];

  if (lastPart === 'create') return `Create${capitalize(entity)}`;
  if (lastPart === 'bulkCreate') return `BulkCreate${capitalize(entity)}`;
  if (method === 'GET' && req.params?.id) return `Get${capitalize(entity)}ById`;
  if (method === 'GET') return `GetAll${capitalize(entity)}`;
  if (method === 'PUT' || method === 'PATCH') return `Update${capitalize(entity)}`;
  if (method === 'DELETE') return `Delete${capitalize(entity)}`;
  return `${method}_${entity}`;
}

function capitalize(str) {
  return str ? str.charAt(0).toUpperCase() + str.slice(1) : '';
}

module.exports = errorHandler;
