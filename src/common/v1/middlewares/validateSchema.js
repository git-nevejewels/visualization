// src/common/v1/middlewares/validateSchema.js
// Common validation middleware — entity-specific versions override this.
// This is a fallback for any entity that doesn't define its own.

const Joi = require('joi');
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const convertJsonSchemaToJoi = (jsonSchema) => {
  // requiredFields is the JSON-Schema-standard array (e.g. jsonSchema.required,
  // or a nested prop.required for an object property) naming which keys AT
  // THIS LEVEL must be present — NOT a per-property boolean flag. A property's
  // own `required` is only ever meaningful when prop.type === 'object': there
  // it's that nested object's OWN required-children array, passed down as the
  // next level's requiredFields.
  const convertProperties = (properties, requiredFields = []) => {
    const joiObj = {};
    for (const key in properties) {
      const prop = properties[key];
      const isRequired = requiredFields.includes(key);
      let joiField;
      switch (prop.type) {
        case 'string':
          joiField = Joi.string();
          if (prop.pattern) joiField = joiField.pattern(new RegExp(prop.pattern));
          if (prop.format === 'date-time') joiField = joiField.isoDate();
          if (!isRequired) joiField = joiField.allow('');
          break;
        case 'number':
          joiField = Joi.number();
          if (prop.minimum !== undefined) joiField = joiField.min(prop.minimum);
          break;
        case 'integer':
          joiField = Joi.number().integer();
          if (prop.minimum !== undefined) joiField = joiField.min(prop.minimum);
          break;
        case 'array':
          joiField = Joi.array().min(prop.minItems || 0);
          if (prop.items) joiField = joiField.items(convertProperties({ [key]: prop.items })[key]);
          break;
        case 'object':
          joiField = Joi.object(convertProperties(prop.properties || {}, prop.required || []));
          break;
        default:
          joiField = Joi.any();
      }
      if (isRequired) joiField = joiField.required();
      joiObj[key] = joiField;
    }
    return joiObj;
  };

  return Joi.object(convertProperties(jsonSchema.properties || {}, jsonSchema.required || []));
};

const validateEntity = (req, res, next) => {
  const { correlationId } = req.correlationContext || {};
  try {
    // Subclasses override with entity-specific schema path
    logger.debug({
      message: 'Common validateSchema called — entity should override',
      messageType: 'EVENT',
      processName: 'ValidateSchema',
      correlationId,
    });
    next();
  } catch (err) {
    logger.error({
      message: `Error during validation: ${err.message}`,
      messageType: 'ERROR',
      processName: 'ValidateSchema',
      correlationId,
      error: err,
    });
    return res.status(500).json({
      status: 'error',
      message: 'Internal server error during validation',
    });
  }
};

module.exports = validateEntity;
