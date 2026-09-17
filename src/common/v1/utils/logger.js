// src/common/v1/utils/logger.js
// ============================================================
// Structured Logger
// ============================================================
// Outputs structured JSON to stdout (Pino) + queues to Kafka buffer.
// ALL Kafka operations are NON-BLOCKING.
// The kafkaProducer.sendLog() pushes to an internal buffer
// and returns immediately. A background loop flushes to Kafka.
// Log schema includes: sessionId, transactionId, correlationId, traceId, spanId.
// ============================================================

const pino = require('pino');
const config = require('../../../../config/config');
const { maskObject, maskHeaders } = require('./masker');
const kafkaProducer = require('./kafkaProducer');

// Initialize Kafka producer connection in background (non-blocking)
kafkaProducer.init();

const pinoLogger = pino({
  level: config.logging.level,
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level(label) { return { level: label.toUpperCase() }; },
  },
  base: {
    service: config.app.serviceName,
    version: config.app.version,
    environment: config.app.environment,
  },
});

// ============================================================
// Payload truncation per log level
// ============================================================
function truncatePayload(payload, level) {
  if (!payload) return undefined;
  const str = typeof payload === 'string' ? payload : JSON.stringify(payload);
  if (level === 'TRACE') return payload;
  if (level === 'DEBUG') {
    if (str.length > config.logging.debugPayloadMaxBytes) {
      return { _truncated: true, _originalSizeBytes: str.length, _preview: str.substring(0, config.logging.debugPayloadMaxBytes) };
    }
    return payload;
  }
  if (level === 'INFO') {
    if (str.length > config.logging.infoPayloadMaxBytes) {
      return { _truncated: true, _originalSizeBytes: str.length, _preview: str.substring(0, config.logging.infoPayloadMaxBytes) };
    }
    return payload;
  }
  return payload;
}

function selectHeaders(headers, level) {
  if (!headers) return undefined;
  if (level === 'TRACE') return headers;
  if (level === 'DEBUG' || level === 'WARN' || level === 'ERROR' || level === 'FATAL') return maskHeaders(headers);
  const keyHeaders = {};
  const allowed = ['content-type', 'x-request-id', 'x-correlation-id', 'x-session-id', 'x-transaction-id', 'accept'];
  for (const [key, value] of Object.entries(headers)) {
    if (allowed.includes(key.toLowerCase())) keyHeaders[key] = value;
  }
  return Object.keys(keyHeaders).length > 0 ? keyHeaders : undefined;
}

// ============================================================
// Build structured log entry (Section 2.2 + sessionId + transactionId)
// ============================================================
function buildLogEntry(level, options = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    level: level.toUpperCase(),
    service: config.app.serviceName,
    version: config.app.version,
    environment: config.app.environment,
    // Tracing IDs
    traceId: options.traceId || undefined,
    spanId: options.spanId || undefined,
    correlationId: options.correlationId || undefined,
    sessionId: options.sessionId || undefined,           // NEW: from X-Session-Id header
    transactionId: options.transactionId || undefined,   // NEW: auto-generated per request
    // Log metadata
    processName: options.processName || undefined,
    messageType: options.messageType || 'EVENT',
    message: options.message || '',
  };

  // Conditional fields
  if (options.targetSystem) entry.targetSystem = options.targetSystem;
  if (options.userId) entry.userId = options.userId;
  if (options.stepCount !== undefined) entry.stepCount = options.stepCount;
  if (options.durationMs !== undefined) entry.durationMs = options.durationMs;
  if (options.httpMethod) entry.httpMethod = options.httpMethod;
  if (options.httpPath) entry.httpPath = options.httpPath;
  if (options.httpStatusCode !== undefined) entry.httpStatusCode = options.httpStatusCode;
  if (options.eventName) entry.eventName = options.eventName;
  if (options.eventType) entry.eventType = options.eventType;

  // Headers
  const selectedHeaders = selectHeaders(options.headers, entry.level);
  if (selectedHeaders) entry.headers = selectedHeaders;

  // Payload - mask then truncate
  if (options.payload !== undefined) {
    // Pass entityName for entity-specific masking rules
    const entityName = options.entityName || options.processName?.split('_')[1] || undefined;
    const masked = maskObject(options.payload, entityName);
    entry.payload = truncatePayload(masked, entry.level);
  }

  // Error block
  if (options.error) {
    entry.error = {
      type: options.error.name || options.error.type || 'Error',
      message: options.error.message || String(options.error),
      stackTrace: options.error.stack || undefined,
      innerError: options.error.innerError || options.error.cause?.message || undefined,
      errorCode: options.error.errorCode || options.error.code || undefined,
      isRetryable: options.error.isRetryable,
    };
  }

  // Metadata
  if (options.metadata && Object.keys(options.metadata).length > 0) {
    entry.metadata = options.metadata;
  }

  // Remove undefined values
  return JSON.parse(JSON.stringify(entry));
}

// ============================================================
// Log function - writes to stdout AND queues to Kafka (non-blocking)
// ============================================================
function log(level, msgOrOpts, opts = {}) {
  const options = typeof msgOrOpts === 'string'
    ? { message: msgOrOpts, ...opts }
    : msgOrOpts;

  const entry = buildLogEntry(level, options);

  // 1. Write to stdout via Pino (synchronous, fast)
  const pinoLevel = level.toLowerCase() === 'fatal' ? 'fatal' : level.toLowerCase();
  if (typeof pinoLogger[pinoLevel] === 'function') {
    pinoLogger[pinoLevel](entry, entry.message);
  } else {
    pinoLogger.info(entry, entry.message);
  }

  // 2. Queue to Kafka buffer (NON-BLOCKING - returns immediately)
  kafkaProducer.sendLog(entry);

  // 3. If ERROR or FATAL, also queue to errors topic (NON-BLOCKING)
  if (level === 'ERROR' || level === 'FATAL' || level === 'error' || level === 'fatal') {
    kafkaProducer.sendError(entry);
  }

  return entry;
}

// Convenience methods
const logger = {
  trace: (m, o) => log('TRACE', m, o),
  debug: (m, o) => log('DEBUG', m, o),
  info: (m, o) => log('INFO', m, o),
  warn: (m, o) => log('WARN', m, o),
  error: (m, o) => log('ERROR', m, o),
  fatal: (m, o) => log('FATAL', m, o),
  log,
  buildLogEntry,
  setLevel(newLevel) { pinoLogger.level = newLevel.toLowerCase(); },
  getPino: () => pinoLogger,
};

module.exports = logger;
