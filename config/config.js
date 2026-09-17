// config/config.js
require('dotenv').config();

module.exports = {
  db: {
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
  },

  entities: {
    image_request: {
      v1: 'ACTIVE',
    },
    base_design: {
      v1: 'ACTIVE', // read-only — no entityModel.js, see src/entities/base_design/v1/models/.gitkeep
    },
    variant_task: {
      v1: 'ACTIVE',
    },
  },

  app: {
    port: process.env.PORT,
    serviceName: process.env.SERVICE_NAME || 'neve-jewels-visualization-api',
    version: process.env.APP_VERSION || '1.0.0',
    environment: process.env.NODE_ENV || 'development',
  },

  // ---------------------
  // Other services this one calls directly (service-to-service, not via the BFF)
  // ---------------------
  urls: {
    merchandising: process.env.MERCHANDISING,
    mdm: process.env.MDM,
    cad: process.env.CAD,
  },

  // ---------------------
  // Logging Configuration
  // ---------------------
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    infoPayloadMaxBytes: 4096,
    debugPayloadMaxBytes: 65536,
  },

  // ---------------------
  // Kafka Configuration
  // ---------------------
  kafka: {
    brokers: (process.env.KAFKA_BROKERS || 'localhost:9092').split(','),
    clientId: process.env.KAFKA_CLIENT_ID || process.env.SERVICE_NAME || 'neve-jewels-visualization-api',

    topics: {
      logs: process.env.KAFKA_TOPIC_LOGS || 'neve-jewels-logs',
      errors: process.env.KAFKA_TOPIC_ERRORS || 'neve-jewels-errors',
      dlq: process.env.KAFKA_TOPIC_DLQ || 'neve-jewels-dlq',
    },

    producer: {
      allowAutoTopicCreation: true,
      transactionTimeout: 30000,
    },
  },

  // ---------------------
  // Retry Configuration
  // ---------------------
  retry: {
    defaults: {
      maxRetries: parseInt(process.env.RETRY_MAX_RETRIES, 10) || 3,
      baseDelayMs: parseInt(process.env.RETRY_BASE_DELAY_MS, 10) || 1000,
      maxDelayMs: parseInt(process.env.RETRY_MAX_DELAY_MS, 10) || 30000,
      timeoutMs: parseInt(process.env.RETRY_TIMEOUT_MS, 10) || 30000,
    },
    integrations: {
      database: {
        maxRetries: 3,
        baseDelayMs: 500,
        maxDelayMs: 5000,
        timeoutMs: 30000,
      },
    },
  },

  // ---------------------
  // Circuit Breaker Configuration
  // ---------------------
  circuitBreaker: {
    sync: {
      failureRatioThreshold: 0.5,
      samplingDurationMs: 10000,
      minimumThroughput: 8,
      breakDurationMs: 30000,
      probeRequests: 3,
    },
    async: {
      failureRatioThreshold: 0.5,
      samplingDurationMs: 30000,
      minimumThroughput: 5,
      breakDurationMs: 60000,
      probeRequests: 3,
    },
  },

  // ---------------------
  // Masking field patterns
  // ---------------------
  masking: {
    sensitiveFieldPatterns: [
      'authorization', 'password', 'secret', 'token', 'apikey', 'api_key',
      'credit_card', 'creditcard', 'card_number', 'cardnumber', 'cvv', 'ssn', 'pan',
    ],
    piiFieldPatterns: [
      'email', 'phone', 'mobile', 'customer_name', 'customerName',
    ],
    neverMaskPatterns: [
      'certificate_id', 'certificateId', 'tag_id', 'tagId',
      'order_id', 'orderId', 'transfer_id', 'transferId',
    ],
  },
};
