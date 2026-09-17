// src/common/v1/utils/domainEventPublisher.js
// Publishes domain events to the workflow inbox after CRUD operations.
// Every event goes to neve-jewels-workflow-inbox. The Workflow Manager
// evaluates rules and then publishes workflowSuccess to the entity's topic.

const crypto = require('crypto');
const config = require('../../../../config/config');
const { topics } = require('./topicConvention');
const logger = require('./logger');

let producer = null;

async function getProducer() {
  if (producer) return producer;
  try {
    const { Kafka } = require('kafkajs');
    const kafka = new Kafka({
      clientId: config.kafka.clientId,
      brokers: config.kafka.brokers,
      retry: { initialRetryTime: 300, retries: 5 },
    });
    producer = kafka.producer(config.kafka.producer || {});
    await producer.connect();
    return producer;
  } catch (err) {
    logger.warn({ message: `Domain event producer failed to connect: ${err.message}` });
    return null;
  }
}

/**
 * Publish a domain event to the workflow inbox.
 *
 * @param {string} eventName - Entity name: "imageRequest", "variantTask", etc.
 * @param {string} eventType - "created", "updated", "deleted", etc.
 * @param {string} eventVersion - "v1", "v2", etc.
 * @param {Object} payload - The entity data
 * @param {Object} options - { correlationId, traceId, spanId, userId }
 */
async function publishDomainEvent(eventName, eventType, eventVersion, payload, options = {}) {
  const event = {
    eventId: `evt-${crypto.randomUUID()}`,
    eventName: eventName.toLowerCase(),
    eventType: eventType.toLowerCase(),
    eventVersion: eventVersion || 'v1',
    eventTimestamp: new Date().toISOString(),
    correlationId: options.correlationId || `${eventName}-${Date.now()}`,
    traceId: options.traceId || crypto.randomBytes(16).toString('hex'),
    spanId: options.spanId || crypto.randomBytes(8).toString('hex'),
    sourceService: config.app.serviceName,
    userId: options.userId || undefined,
    payload,
  };

  const topic = topics.workflowInbox();

  try {
    const prod = await getProducer();
    if (!prod) {
      logger.warn({ message: `Cannot publish domain event - Kafka unavailable`, eventName, eventType });
      return event;
    }

    await prod.send({
      topic,
      messages: [{
        key: event.correlationId,
        value: JSON.stringify(event),
        headers: {
          eventName: event.eventName,
          eventType: event.eventType,
          eventVersion: event.eventVersion,
          sourceService: config.app.serviceName,
        },
      }],
    });

    logger.info({
      message: `Domain event published: ${eventName}.${eventType} -> ${topic}`,
      messageType: 'EVENT',
      processName: 'DomainEventPublisher',
      correlationId: event.correlationId,
      metadata: { eventId: event.eventId, topic, eventName, eventType, eventVersion },
    });

    return event;
  } catch (err) {
    logger.error({
      message: `Failed to publish domain event: ${err.message}`,
      processName: 'DomainEventPublisher',
      correlationId: event.correlationId,
      error: err,
    });
    return event;
  }
}

async function disconnect() {
  if (producer) { await producer.disconnect(); producer = null; }
}

module.exports = { publishDomainEvent, disconnect };
