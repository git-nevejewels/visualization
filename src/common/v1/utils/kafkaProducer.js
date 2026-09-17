// src/common/v1/utils/kafkaProducer.js
// ============================================================
// Async Kafka Log Shipper
// ============================================================
// ALL Kafka sends are async and non-blocking.
// Logs are queued in an internal buffer and batch-flushed
// every FLUSH_INTERVAL_MS in a background loop.
// If Kafka is unavailable, logs go to stdout only (no crash).
// This guarantees zero impact on API response times.
// ============================================================

const { Kafka } = require('kafkajs');
const config = require('../../../../config/config');

let producer = null;
let isConnected = false;
let connectPromise = null;
let flushTimer = null;

// Internal buffers — one per topic
const buffers = {
  logs: [],
  errors: [],
  dlq: [],
};

const MAX_BUFFER_SIZE = 100;
const FLUSH_INTERVAL_MS = 2000; // Flush every 2 seconds

// ============================================================
// Producer connection (lazy, async, non-blocking)
// ============================================================
async function getProducer() {
  if (isConnected && producer) return producer;
  if (connectPromise) return connectPromise;

  connectPromise = (async () => {
    try {
      const kafka = new Kafka({
        clientId: config.kafka.clientId,
        brokers: config.kafka.brokers,
        retry: { initialRetryTime: 300, retries: 3 },
      });
      producer = kafka.producer(config.kafka.producer || {});
      await producer.connect();
      isConnected = true;

      producer.on('producer.disconnect', () => {
        isConnected = false;
        connectPromise = null;
      });

      // Start the background flush loop
      startFlushLoop();

      return producer;
    } catch (err) {
      console.error(`[KafkaProducer] Connect failed: ${err.message}`);
      isConnected = false;
      connectPromise = null;
      return null;
    }
  })();

  return connectPromise;
}

// ============================================================
// Background flush loop — sends buffered messages in batches
// ============================================================
function startFlushLoop() {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    flushBuffer('logs', config.kafka.topics.logs);
    flushBuffer('errors', config.kafka.topics.errors);
    flushBuffer('dlq', config.kafka.topics.dlq);
  }, FLUSH_INTERVAL_MS);
}

async function flushBuffer(bufferName, topic) {
  if (!buffers[bufferName].length || !isConnected || !producer) return;

  const batch = buffers[bufferName].splice(0, MAX_BUFFER_SIZE);
  if (!batch.length) return;

  try {
    await producer.send({
      topic,
      messages: batch,
    });
  } catch (err) {
    // Failed to send — messages are lost (already written to stdout)
    // Do NOT re-queue to prevent infinite growth
    console.error(`[KafkaProducer] Flush failed for ${topic}: ${err.message} (${batch.length} messages dropped)`);
  }
}

// ============================================================
// Public API — all methods are NON-BLOCKING
// They queue to the buffer and return immediately.
// ============================================================

/**
 * Queue a log entry for async shipping to the logs topic.
 * Returns immediately — never blocks.
 */
function sendLog(logEntry) {
  buffers.logs.push({
    key: logEntry.correlationId || logEntry.transactionId || null,
    value: JSON.stringify(logEntry),
    headers: {
      level: logEntry.level || 'INFO',
      service: logEntry.service || '',
      messageType: logEntry.messageType || 'EVENT',
    },
  });

  // Trigger immediate flush if buffer is getting large
  if (buffers.logs.length >= MAX_BUFFER_SIZE) {
    flushBuffer('logs', config.kafka.topics.logs).catch(() => {});
  }
}

/**
 * Queue an error entry for async shipping to the errors topic.
 */
function sendError(errorEntry) {
  buffers.errors.push({
    key: errorEntry.correlationId || errorEntry.transactionId || null,
    value: JSON.stringify(errorEntry),
    headers: {
      level: 'ERROR',
      service: errorEntry.service || '',
      errorCode: errorEntry.error?.errorCode || 'UNKNOWN',
      isRetryable: String(errorEntry.error?.isRetryable || false),
    },
  });

  if (buffers.errors.length >= MAX_BUFFER_SIZE) {
    flushBuffer('errors', config.kafka.topics.errors).catch(() => {});
  }
}

/**
 * Queue a DLQ entry for async shipping to the DLQ topic.
 */
function sendToDLQ(message) {
  const enriched = {
    ...message,
    dlqTimestamp: new Date().toISOString(),
    dlqReason: message.dlqReason || 'Max retries exhausted',
  };

  buffers.dlq.push({
    key: message.correlationId || null,
    value: JSON.stringify(enriched),
    headers: {
      service: message.service || config.app?.serviceName || '',
      errorCode: message.error?.errorCode || 'UNKNOWN',
    },
  });

  if (buffers.dlq.length >= MAX_BUFFER_SIZE) {
    flushBuffer('dlq', config.kafka.topics.dlq).catch(() => {});
  }
}

/**
 * Initialize the producer connection (call at startup).
 * Non-blocking — connection happens in background.
 */
function init() {
  getProducer().catch(() => {});
}

/**
 * Graceful shutdown — flush remaining buffers, disconnect.
 */
async function disconnect() {
  if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }

  // Final flush
  try {
    if (isConnected && producer) {
      await flushBuffer('logs', config.kafka.topics.logs);
      await flushBuffer('errors', config.kafka.topics.errors);
      await flushBuffer('dlq', config.kafka.topics.dlq);
      await producer.disconnect();
    }
  } catch (err) {
    console.error(`[KafkaProducer] Disconnect error: ${err.message}`);
  }
  isConnected = false;
  producer = null;
}

module.exports = {
  sendLog,     // Non-blocking — queues to buffer
  sendError,   // Non-blocking — queues to buffer
  sendToDLQ,   // Non-blocking — queues to buffer
  init,        // Non-blocking — starts connection in background
  disconnect,  // Async — flushes and disconnects
};
