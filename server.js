// server.js
const express = require('express');
require('dotenv').config();
const swaggerUi = require('swagger-ui-express');
const swaggerSpec = require('./src/common/v1/swagger/swagger');

const { loadEntities, sequelize } = require('./src/common/v1/loaders/entityLoader');
const logger = require('./src/common/v1/utils/logger');
const kafkaProducer = require('./src/common/v1/utils/kafkaProducer');
const { getAllStates } = require('./src/common/v1/utils/circuitBreaker');

// Middlewares
const correlationIdMiddleware = require('./src/common/v1/middlewares/correlationId');
const requestLoggerMiddleware = require('./src/common/v1/middlewares/requestLogger');
const globalErrorHandler = require('./src/common/v1/middlewares/errorHandler');

const app = express();
app.use(express.json());

// ---------------------
// 1. Correlation ID middleware (must be first)
// ---------------------
app.use(correlationIdMiddleware);

// ---------------------
// 2. Request/Response logging middleware
// ---------------------
app.use(requestLoggerMiddleware);

// ---------------------
// 3. Swagger docs
// ---------------------
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// ---------------------
// 3b. Static demo pages (dev-only wireframe walkthroughs, not part of the API surface)
// ---------------------
app.use(express.static('public'));

// ---------------------
// 4. Health check endpoint
// ---------------------
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    service: process.env.SERVICE_NAME || 'neve-jewels-visualization-api',
    version: process.env.APP_VERSION || '1.0.0',
    environment: process.env.NODE_ENV || 'development',
    uptime: process.uptime(),
    circuitBreakers: getAllStates(),
  });
});

// ---------------------
// 5. Load entities (models + routes)
// ---------------------
loadEntities(app);

// ---------------------
// 6. Global error handler (MUST be after all routes)
// ---------------------
app.use(globalErrorHandler);

// ---------------------
// 7. Unhandled rejection & uncaught exception handlers
// ---------------------
process.on('unhandledRejection', (reason, promise) => {
  logger.fatal({
    message: `Unhandled Promise Rejection: ${reason?.message || reason}`,
    messageType: 'ERROR',
    processName: 'UnhandledRejection',
    error: reason instanceof Error ? reason : { message: String(reason) },
  });
});

process.on('uncaughtException', (err) => {
  logger.fatal({
    message: `Uncaught Exception: ${err.message}`,
    messageType: 'ERROR',
    processName: 'UncaughtException',
    error: err,
  });
  setTimeout(() => process.exit(1), 1000);
});

// ---------------------
// 8. Graceful shutdown
// ---------------------
async function gracefulShutdown(signal) {
  logger.info({
    message: `${signal} received — starting graceful shutdown`,
    messageType: 'EVENT',
    processName: 'Shutdown',
  });

  try {
    await kafkaProducer.disconnect();
    await sequelize.close();
    logger.info({
      message: 'Graceful shutdown complete',
      messageType: 'EVENT',
      processName: 'Shutdown',
    });
    process.exit(0);
  } catch (err) {
    logger.error({
      message: `Error during shutdown: ${err.message}`,
      messageType: 'ERROR',
      processName: 'Shutdown',
      error: err,
    });
    process.exit(1);
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ---------------------
// 9. Start server
// ---------------------
sequelize
  .sync()
  .then(() => {
    logger.info({
      message: 'Database synced successfully',
      messageType: 'EVENT',
      processName: 'Startup',
      targetSystem: 'Database',
    });

    const port = process.env.PORT || 3000;
    app.listen(port, () => {
      logger.info({
        message: `Server running on port ${port}`,
        messageType: 'EVENT',
        processName: 'Startup',
        metadata: {
          port,
          environment: process.env.NODE_ENV || 'development',
          serviceName: process.env.SERVICE_NAME || 'neve-jewels-visualization-api',
        },
      });
    });
  })
  .catch(err => {
    logger.fatal({
      message: `Database sync failed: ${err.message}`,
      messageType: 'ERROR',
      processName: 'Startup',
      targetSystem: 'Database',
      error: err,
    });
    process.exit(1);
  });
