// src/common/v1/utils/circuitBreaker.js
// Implements Section 4.3 — Circuit Breaker Pattern
// States: CLOSED → OPEN → HALF-OPEN → CLOSED

const config = require('../../../../config/config');
const logger = require('./logger');

const STATE = {
  CLOSED: 'CLOSED',
  OPEN: 'OPEN',
  HALF_OPEN: 'HALF-OPEN',
};

class CircuitBreaker {
  /**
   * @param {string} name - Name of the downstream system (e.g., 'scurri', 'oms')
   * @param {Object} options - Override default config
   * @param {'sync'|'async'} options.type - 'sync' or 'async' defaults from config
   */
  constructor(name, options = {}) {
    this.name = name;
    const type = options.type || 'sync';
    const defaults = config.circuitBreaker[type] || config.circuitBreaker.sync;

    this.failureRatioThreshold = options.failureRatioThreshold ?? defaults.failureRatioThreshold;
    this.samplingDurationMs = options.samplingDurationMs ?? defaults.samplingDurationMs;
    this.minimumThroughput = options.minimumThroughput ?? defaults.minimumThroughput;
    this.breakDurationMs = options.breakDurationMs ?? defaults.breakDurationMs;
    this.probeRequests = options.probeRequests ?? defaults.probeRequests;

    this.state = STATE.CLOSED;
    this.failures = [];
    this.successes = [];
    this.openedAt = null;
    this.halfOpenAttempts = 0;
    this.halfOpenSuccesses = 0;
  }

  /**
   * Prune old entries outside the sampling window.
   */
  _pruneWindow() {
    const cutoff = Date.now() - this.samplingDurationMs;
    this.failures = this.failures.filter(t => t > cutoff);
    this.successes = this.successes.filter(t => t > cutoff);
  }

  /**
   * Get the current failure ratio within the sampling window.
   */
  _getFailureRatio() {
    this._pruneWindow();
    const total = this.failures.length + this.successes.length;
    if (total < this.minimumThroughput) return 0;
    return this.failures.length / total;
  }

  /**
   * Execute an operation through the circuit breaker.
   */
  async execute(operation, { correlationId, processName } = {}) {
    // OPEN state: reject immediately
    if (this.state === STATE.OPEN) {
      const elapsed = Date.now() - this.openedAt;
      if (elapsed < this.breakDurationMs) {
        const err = new Error(`Circuit breaker OPEN for ${this.name}. Rejecting request.`);
        err.name = 'BrokenCircuitException';
        err.isRetryable = false;
        err.errorCode = `CIRCUIT_OPEN_${this.name.toUpperCase()}`;

        logger.warn({
          message: `Circuit breaker OPEN for ${this.name} - request rejected`,
          messageType: 'EVENT',
          processName,
          correlationId,
          targetSystem: this.name,
          metadata: {
            circuitState: STATE.OPEN,
            openedAt: new Date(this.openedAt).toISOString(),
            breakDurationMs: this.breakDurationMs,
            remainingMs: this.breakDurationMs - elapsed,
          },
        });

        throw err;
      }

      // Break duration expired — move to HALF-OPEN
      this.state = STATE.HALF_OPEN;
      this.halfOpenAttempts = 0;
      this.halfOpenSuccesses = 0;

      logger.info({
        message: `Circuit breaker for ${this.name} moved to HALF-OPEN - sending probe requests`,
        messageType: 'EVENT',
        processName,
        correlationId,
        targetSystem: this.name,
        metadata: { circuitState: STATE.HALF_OPEN },
      });
    }

    // HALF-OPEN state: allow limited probe requests
    if (this.state === STATE.HALF_OPEN) {
      try {
        const result = await operation();
        this.halfOpenAttempts++;
        this.halfOpenSuccesses++;

        if (this.halfOpenSuccesses >= this.probeRequests) {
          // All probes succeeded — CLOSE the circuit
          this.state = STATE.CLOSED;
          this.failures = [];
          this.successes = [];
          this.openedAt = null;

          logger.info({
            message: `Circuit breaker for ${this.name} CLOSED - probes succeeded`,
            messageType: 'EVENT',
            processName,
            correlationId,
            targetSystem: this.name,
            metadata: { circuitState: STATE.CLOSED },
          });
        }

        return result;
      } catch (err) {
        // Probe failed — re-OPEN
        this.state = STATE.OPEN;
        this.openedAt = Date.now();

        logger.warn({
          message: `Circuit breaker for ${this.name} re-OPENED - probe failed: ${err.message}`,
          messageType: 'EVENT',
          processName,
          correlationId,
          targetSystem: this.name,
          metadata: {
            circuitState: STATE.OPEN,
            breakDurationMs: this.breakDurationMs,
          },
        });

        throw err;
      }
    }

    // CLOSED state: pass through and monitor
    try {
      const result = await operation();
      this.successes.push(Date.now());
      return result;
    } catch (err) {
      this.failures.push(Date.now());

      // Check if we should trip the breaker
      const ratio = this._getFailureRatio();
      if (ratio >= this.failureRatioThreshold) {
        this.state = STATE.OPEN;
        this.openedAt = Date.now();

        logger.error({
          message: `Circuit breaker for ${this.name} OPENED - failure ratio ${(ratio * 100).toFixed(1)}% exceeded threshold`,
          messageType: 'EVENT',
          processName,
          correlationId,
          targetSystem: this.name,
          metadata: {
            circuitState: STATE.OPEN,
            failureRatio: ratio,
            threshold: this.failureRatioThreshold,
            breakDurationMs: this.breakDurationMs,
          },
        });
      }

      throw err;
    }
  }

  /**
   * Get current state info (for health checks / monitoring).
   */
  getState() {
    this._pruneWindow();
    return {
      name: this.name,
      state: this.state,
      failureRatio: this._getFailureRatio(),
      recentFailures: this.failures.length,
      recentSuccesses: this.successes.length,
      openedAt: this.openedAt ? new Date(this.openedAt).toISOString() : null,
    };
  }
}

// -------------------------------------------------------------------
// Circuit Breaker Registry (one per downstream system)
// -------------------------------------------------------------------
const breakers = new Map();

function getCircuitBreaker(name, options = {}) {
  if (!breakers.has(name)) {
    breakers.set(name, new CircuitBreaker(name, options));
  }
  return breakers.get(name);
}

function getAllStates() {
  const states = {};
  for (const [name, breaker] of breakers) {
    states[name] = breaker.getState();
  }
  return states;
}

module.exports = {
  CircuitBreaker,
  getCircuitBreaker,
  getAllStates,
  STATE,
};
