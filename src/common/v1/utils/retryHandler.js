// src/common/v1/utils/retryHandler.js
// Implements Section 4.2 — Exponential Backoff with Jitter
// Formula: delay = min(baseDelay * 2^attemptNumber + randomJitter, maxDelay)

const config = require('../../../../config/config');
const logger = require('./logger');
const { classifyError } = require('./errorClassifier');
const kafkaProducer = require('./kafkaProducer');

/**
 * Calculate retry delay with exponential backoff + jitter.
 * Section 4.2.1:
 *   delay = min(baseDelay * 2^attempt + random(0, baseDelay), maxDelay)
 */
function calculateDelay(attempt, { baseDelayMs, maxDelayMs }) {
  const exponential = baseDelayMs * Math.pow(2, attempt);
  const jitter = Math.random() * baseDelayMs;
  return Math.min(exponential + jitter, maxDelayMs);
}

/**
 * Sleep for specified milliseconds.
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Execute an operation with retry logic.
 *
 * @param {Function} operation - Async function to execute
 * @param {Object} options
 * @param {string} options.processName - Logical operation name for logging
 * @param {string} options.correlationId - Business correlation ID
 * @param {string} options.targetSystem - Downstream system being called
 * @param {string} options.integration - Integration name (maps to config.retry.integrations)
 * @param {number} options.maxRetries - Override max retries
 * @param {number} options.baseDelayMs - Override base delay
 * @param {number} options.maxDelayMs - Override max delay
 * @param {Object} options.metadata - Additional metadata for logging
 */
async function withRetry(operation, options = {}) {
  const {
    processName = 'UnknownOperation',
    correlationId,
    targetSystem,
    integration,
    metadata = {},
  } = options;

  // Resolve retry config: per-integration > override > defaults
  const integrationConfig = integration
    ? config.retry.integrations[integration] || {}
    : {};

  const maxRetries = options.maxRetries ?? integrationConfig.maxRetries ?? config.retry.defaults.maxRetries;
  const baseDelayMs = options.baseDelayMs ?? integrationConfig.baseDelayMs ?? config.retry.defaults.baseDelayMs;
  const maxDelayMs = options.maxDelayMs ?? integrationConfig.maxDelayMs ?? config.retry.defaults.maxDelayMs;

  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await operation();
      return result;
    } catch (err) {
      lastError = err;

      // Classify the error
      const classification = classifyError(err);
      err.isRetryable = classification.isRetryable;
      err.errorCode = classification.errorCode;

      // NON-RETRYABLE: log and throw immediately (Section 4.1 RULE)
      if (!classification.isRetryable) {
        logger.error({
          message: `Non-retryable error in ${processName}: ${err.message}`,
          messageType: 'ERROR',
          processName,
          correlationId,
          targetSystem,
          error: err,
          metadata: {
            ...metadata,
            retryAttempt: attempt,
            maxRetries,
            isRetryable: false,
          },
        });
        throw err;
      }

      // RETRYABLE but exhausted all retries
      if (attempt >= maxRetries) {
        const nextRetryAt = null; // no more retries

        logger.error({
          message: `Max retries exhausted for ${processName}: ${err.message}`,
          messageType: 'ERROR',
          processName,
          correlationId,
          targetSystem,
          error: err,
          metadata: {
            ...metadata,
            retryAttempt: attempt,
            maxRetries,
            isRetryable: true,
            retriesExhausted: true,
          },
        });

        // Send to DLQ via Kafka (Section 4.4)
        await kafkaProducer.sendToDLQ({
          service: config.app.serviceName,
          processName,
          correlationId,
          targetSystem,
          error: {
            type: err.name,
            message: err.message,
            errorCode: classification.errorCode,
            isRetryable: true,
          },
          metadata: {
            ...metadata,
            totalAttempts: attempt + 1,
            maxRetries,
          },
          dlqReason: 'Max retries exhausted',
        });

        throw err;
      }

      // RETRYABLE with retries remaining — wait and retry
      const delay = calculateDelay(attempt, { baseDelayMs, maxDelayMs });
      const nextRetryAt = new Date(Date.now() + delay).toISOString();

      logger.warn({
        message: `Retryable error in ${processName}, attempt ${attempt + 1}/${maxRetries}: ${err.message}`,
        messageType: 'ERROR',
        processName,
        correlationId,
        targetSystem,
        error: err,
        metadata: {
          ...metadata,
          retryAttempt: attempt + 1,
          maxRetries,
          nextRetryAt,
          delayMs: Math.round(delay),
          isRetryable: true,
        },
      });

      await sleep(delay);
    }
  }

  // Should not reach here, but safety net
  throw lastError;
}

module.exports = {
  withRetry,
  calculateDelay,
};
