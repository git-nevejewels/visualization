// utils/queryExecutor.js
// Database operation wrapper with:
//   - Section 4.1 error classification
//   - Section 4.2 retry with exponential backoff + jitter (database integration config)
//   - Structured logging for all DB operations

const logger = require('../src/common/v1/utils/logger');
const { classifyError } = require('../src/common/v1/utils/errorClassifier');
const { withRetry } = require('../src/common/v1/utils/retryHandler');

/**
 * Execute a database operation with retry logic and structured logging.
 *
 * @param {Function} operation - Async function that performs the DB operation
 * @param {Object} options
 * @param {number} options.successStatus - HTTP status on success (default: 200)
 * @param {*} options.emptyData - Data to return when result is null (default: null)
 * @param {number} options.notFoundStatus - HTTP status when not found (default: 404)
 * @param {string} options.processName - Logical operation name for logging
 * @param {string} options.correlationId - Business correlation ID
 * @param {Object} options.metadata - Additional metadata for logging
 */
const executeOperation = async (operation, options = {}) => {
  const {
    successStatus = 200,
    emptyData = null,
    notFoundStatus = 404,
    processName = 'DatabaseOperation',
    correlationId,
    metadata = {},
  } = options;

  const startTime = Date.now();

  try {
    // Wrap in retry handler with database-specific config (Section 4.5)
    const data = await withRetry(
      () => operation(),
      {
        processName,
        correlationId,
        targetSystem: 'Database',
        integration: 'database',
        metadata,
      }
    );

    const durationMs = Date.now() - startTime;

    // Handle "not found" cases
    if (!data) {
      logger.debug({
        message: `${processName}: entity not found`,
        messageType: 'RESPONSE',
        processName,
        correlationId,
        targetSystem: 'Database',
        durationMs,
        httpStatusCode: notFoundStatus,
        metadata,
      });

      return {
        status: notFoundStatus,
        data: emptyData,
      };
    }

    logger.debug({
      message: `${processName}: operation successful`,
      messageType: 'RESPONSE',
      processName,
      correlationId,
      targetSystem: 'Database',
      durationMs,
      httpStatusCode: successStatus,
      metadata,
    });

    return {
      status: successStatus,
      data,
    };
  } catch (err) {
    const durationMs = Date.now() - startTime;
    const classification = classifyError(err);

    logger.error({
      message: `${processName}: DB operation failed — ${err.message}`,
      messageType: 'ERROR',
      processName,
      correlationId,
      targetSystem: 'Database',
      durationMs,
      error: {
        ...err,
        type: err.name,
        errorCode: classification.errorCode,
        isRetryable: classification.isRetryable,
      },
      metadata: {
        ...metadata,
        isRetryable: classification.isRetryable,
      },
    });

    // Map Sequelize errors to HTTP status codes
    if (err.name === 'SequelizeValidationError') {
      return { status: 400, data: emptyData };
    }
    if (err.name === 'SequelizeUniqueConstraintError') {
      return { status: 409, data: emptyData };
    }
    if (err.name?.includes('Connection')) {
      return { status: 503, data: emptyData };
    }

    return {
      status: 500,
      data: emptyData,
    };
  }
};

module.exports = {
  executeOperation,
};
