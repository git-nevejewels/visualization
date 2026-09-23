// src/entities/variant_task/v1/middlewares/validateSchema.js
const Joi = require('joi');
const fs = require('fs');
const path = require('path');
const logger = require('../../../../common/v1/utils/logger');

// --------------------
// Convert JSON schema to Joi schema (recursive)
// --------------------
const convertJsonSchemaToJoi = (jsonSchema) => {
  // requiredFields is the JSON-Schema-standard array (e.g. jsonSchema.required,
  // or a nested prop.required for an object property) naming which keys AT
  // THIS LEVEL must be present — NOT a per-property boolean flag. A property's
  // own `required` is only ever meaningful when prop.type === 'object' (and no
  // additionalProperties): there it's that nested object's OWN required-children
  // array, passed down as the next level's requiredFields.
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
          if (prop.enum) joiField = joiField.valid(...prop.enum);
          if (prop.minLength) joiField = joiField.min(prop.minLength);
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
        case 'boolean':
          joiField = Joi.boolean();
          break;
        case 'array':
          joiField = Joi.array().min(prop.minItems || 0);
          if (prop.items) {
            joiField = joiField.items(convertProperties({ _item: prop.items })['_item']);
          }
          break;
        case 'object':
          if (prop.additionalProperties) {
            const valueSchema = prop.additionalProperties.type === 'string'
              ? Joi.string().allow('')
              : prop.additionalProperties.type === 'number'
                ? Joi.number().allow('')
                : Joi.any();
            joiField = Joi.object().pattern(Joi.string(), valueSchema);
            if (prop.minProperties) joiField = joiField.min(prop.minProperties);
          } else {
            joiField = Joi.object(convertProperties(prop.properties || {}, prop.required || []));
          }
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

// --------------------
// Middleware function
// --------------------
const validateEntity = (req, res, next) => {
  const { correlationId, traceId, spanId } = req.correlationContext || {};

  try {
    const entityName = path.basename(path.join(__dirname, '..', '..'));
    const schemaPath = path.join(__dirname, '../schemas', 'entitySchema.json');

    if (!fs.existsSync(schemaPath)) {
      logger.error({
        message: `Validation schema missing for entity: ${entityName}`,
        messageType: 'ERROR',
        processName: 'ValidateSchema',
        correlationId,
        traceId,
        spanId,
        metadata: { entityName, schemaPath },
      });
      return res.status(500).json({
        status: 500,
        error: `Validation schema missing for entity: ${entityName}`,
      });
    }

    const jsonSchema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
    const joiSchema = convertJsonSchemaToJoi(jsonSchema);
    // bulkCreate posts an array body through this same middleware — validate each
    // element against the entity schema rather than the whole array, since
    // Joi.object() rejects an array outright.
    const schemaToValidate = Array.isArray(req.body)
      ? Joi.array().items(joiSchema).min(1)
      : joiSchema;
    const { error } = schemaToValidate.validate(req.body, { abortEarly: false });

    if (error) {
      logger.warn({
        message: `Validation failed for ${entityName}: ${error.details.map(d => d.message).join(', ')}`,
        messageType: 'ERROR',
        processName: 'ValidateSchema',
        correlationId,
        traceId,
        spanId,
        httpStatusCode: 400,
        metadata: { entityName, validationErrors: error.details },
      });
      return res.status(400).json({
        status: 400,
        error: 'Validation failed',
        details: error.details,
        correlationId,
      });
    }

    next();
  } catch (err) {
    logger.error({
      message: `Error during validation: ${err.message}`,
      messageType: 'ERROR',
      processName: 'ValidateSchema',
      correlationId,
      traceId,
      spanId,
      error: err,
    });
    return res.status(500).json({
      status: 500,
      error: 'Internal server error during validation',
    });
  }
};

module.exports = validateEntity;
