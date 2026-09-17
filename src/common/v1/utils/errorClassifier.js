// src/common/v1/utils/errorClassifier.js
// Implements Section 4.1 — Error Classification
// Every error must be classified as RETRYABLE or NON-RETRYABLE.

// HTTP status codes that are retryable (Section 4.1)
const RETRYABLE_HTTP_CODES = new Set([408, 429, 500, 502, 503, 504]);

// HTTP status codes that are NOT retryable
const NON_RETRYABLE_HTTP_CODES = new Set([400, 401, 403, 404, 422]);

// Error names / types that indicate transient failures
const RETRYABLE_ERROR_TYPES = [
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'EHOSTUNREACH',
  'SequelizeConnectionError',
  'SequelizeConnectionRefusedError',
  'SequelizeConnectionTimedOutError',
  'SequelizeHostNotFoundError',
];

// Sequelize errors that are never retryable
const NON_RETRYABLE_SEQUELIZE = [
  'SequelizeValidationError',
  'SequelizeUniqueConstraintError',
  'SequelizeForeignKeyConstraintError',
  'SequelizeExclusionConstraintError',
  'SequelizeDatabaseError', // bad SQL, schema mismatch, etc.
];

/**
 * Classify an error as retryable or non-retryable.
 * Returns an enriched error object with isRetryable and errorCode.
 */
function classifyError(err) {
  if (!err) return { isRetryable: false, errorCode: 'UNKNOWN' };

  // If already classified, return as-is
  if (err.isRetryable !== undefined) {
    return {
      isRetryable: err.isRetryable,
      errorCode: err.errorCode || err.code || 'UNKNOWN',
    };
  }

  // HTTP status code based classification
  if (err.statusCode || err.status) {
    const code = err.statusCode || err.status;
    if (RETRYABLE_HTTP_CODES.has(code)) {
      return { isRetryable: true, errorCode: `HTTP_${code}` };
    }
    if (NON_RETRYABLE_HTTP_CODES.has(code)) {
      return { isRetryable: false, errorCode: `HTTP_${code}` };
    }
  }

  // Error code / name classification
  const errCode = err.code || err.name || '';

  if (RETRYABLE_ERROR_TYPES.some(t => errCode.includes(t))) {
    return { isRetryable: true, errorCode: errCode };
  }

  if (NON_RETRYABLE_SEQUELIZE.some(t => errCode.includes(t) || (err.name && err.name.includes(t)))) {
    return { isRetryable: false, errorCode: err.name || errCode };
  }

  // Connection-related error names
  if (err.name && err.name.includes('Connection')) {
    return { isRetryable: true, errorCode: err.name };
  }

  // Timeout detection
  if (err.message && (err.message.includes('timeout') || err.message.includes('timed out'))) {
    return { isRetryable: true, errorCode: 'TIMEOUT' };
  }

  // Default: non-retryable (fail safe — don't retry unknown errors)
  return { isRetryable: false, errorCode: err.code || err.name || 'UNKNOWN' };
}

module.exports = {
  classifyError,
  RETRYABLE_HTTP_CODES,
  NON_RETRYABLE_HTTP_CODES,
};
