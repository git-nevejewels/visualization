// src/common/v1/utils/topicConvention.js
// ============================================================
// Neve Jewels — Kafka Topic Naming Convention
// ============================================================
// ALL services must use these functions to derive topic names.
// This ensures consistency across the entire ecosystem.
//
// TOPIC FLOW:
//   API Template (CRUD)
//     → publishes to: neve-jewels-workflow-inbox
//       { eventName, eventType: "created"|"updated"|"deleted", eventVersion, payload }
//
//   Workflow Manager (consumes neve-jewels-workflow-inbox)
//     → evaluates rules
//     → publishes to: neve-jewels-domain-events-{entityName}
//       { eventName, eventType: "workflowSuccess", originalEventType, eventVersion, payload }
//     → if NO rules: publishes workflowSuccess directly (pass-through)
//
//   Kafka Receiver (consumes neve-jewels-domain-events-{entityName})
//     → only processes eventType: "workflowSuccess"
//     → does business logic
//     → publishes NEW events to: neve-jewels-workflow-inbox
//
// LOGGING TOPICS (unchanged):
//   neve-jewels-logs
//   neve-jewels-errors
//   neve-jewels-dlq
// ============================================================

const TOPIC_PREFIX = 'neve-jewels';

const topics = {
  /**
   * Workflow inbox — ALL domain events go here first.
   * The Workflow Manager consumes this topic.
   */
  workflowInbox: () => `${TOPIC_PREFIX}-workflow-inbox`,

  /**
   * Per-entity domain events topic — receives workflowSuccess events only.
   * Kafka Receivers subscribe to the entity topics they care about.
   * @param {string} entityName - e.g. "imageRequest" → "neve-jewels-domain-events-imagerequest"
   */
  domainEvents: (entityName) => `${TOPIC_PREFIX}-domain-events-${entityName.toLowerCase()}`,

  /**
   * Logging topics (unchanged from logging framework).
   */
  logs: () => `${TOPIC_PREFIX}-logs`,
  errors: () => `${TOPIC_PREFIX}-errors`,
  dlq: () => `${TOPIC_PREFIX}-dlq`,
};

/**
 * Standard event types.
 */
const EVENT_TYPES = {
  CREATED: 'created',
  UPDATED: 'updated',
  DELETED: 'deleted',
  STATUS_CHANGED: 'statusChanged',
  COMPLETED: 'completed',
  FAILED: 'failed',
  // The workflow manager sets this after rule evaluation
  WORKFLOW_SUCCESS: 'workflowSuccess',
  WORKFLOW_REJECTED: 'workflowRejected',
};

module.exports = { topics, EVENT_TYPES, TOPIC_PREFIX };
