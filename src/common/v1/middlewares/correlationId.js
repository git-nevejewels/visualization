// src/common/v1/middlewares/correlationId.js
// ============================================================
// Generates/propagates correlation context on every request:
//   correlationId  - from X-Correlation-Id header or auto-generated
//   sessionId      - from X-Session-Id header (sent by API caller)
//   transactionId  - auto-generated UUID per request
//   traceId        - from X-Trace-Id / traceparent header or auto-generated
//   spanId         - from X-Span-Id / traceparent header or auto-generated
// ============================================================

const crypto = require('crypto');

function correlationIdMiddleware(req, res, next) {
  // Correlation ID - business-level, threaded across events
  const correlationId =
    req.headers['x-correlation-id'] ||
    req.headers['x-request-id'] ||
    crypto.randomBytes(16).toString('hex');

  // Session ID - sent by the API caller (e.g. browser session, Postman)
  const sessionId =
    req.headers['x-session-id'] ||
    req.headers['x-session'] ||
    undefined;

  // Transaction ID - unique per request, auto-generated
  const transactionId = crypto.randomUUID();

  // OpenTelemetry trace context
  let traceId = req.headers['x-trace-id'] || null;
  let spanId = req.headers['x-span-id'] || null;

  // Parse W3C traceparent if present: 00-{traceId}-{spanId}-{flags}
  const traceparent = req.headers['traceparent'];
  if (traceparent) {
    const parts = traceparent.split('-');
    if (parts.length >= 3) {
      traceId = parts[1];
      spanId = parts[2];
    }
  }

  if (!traceId) traceId = crypto.randomBytes(16).toString('hex');
  if (!spanId) spanId = crypto.randomBytes(8).toString('hex');

  // Attach to request for use throughout the pipeline
  req.correlationContext = {
    correlationId,
    sessionId,
    transactionId,
    traceId,
    spanId,
  };

  // Set on response headers
  res.setHeader('X-Correlation-Id', correlationId);
  res.setHeader('X-Transaction-Id', transactionId);
  res.setHeader('X-Trace-Id', traceId);
  res.setHeader('X-Span-Id', spanId);
  if (sessionId) res.setHeader('X-Session-Id', sessionId);

  next();
}

module.exports = correlationIdMiddleware;
