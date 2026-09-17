const { DataTypes } = require('sequelize');
const path = require('path');

/**
 * This file MUST NOT:
 * - create sequelize instance
 * - read config.entity
 * - export sequelize
 *
 * It ONLY defines models and RETURNS them
 *
 * Auto-detect entityName and version from folder structure:
 * entities/<entityName>/<version>/models/entityModel.js
 */
const servicesFolder = __dirname; // current folder
const version = path.basename(path.dirname(__dirname)); // parent folder = version
const entityName = path.basename(path.join(__dirname, '..', '..')); // two levels up = entityName

module.exports = (sequelize) => {
  const baseTable = `${entityName.toLowerCase()}`;
  const idField = `${entityName.toLowerCase()}_id`;
  const detailsField = `${entityName.toLowerCase()}_details`;

  // Main table model
  const EntityModel = sequelize.define(
    baseTable,
    {
      [idField]: {
        type: DataTypes.STRING,
        allowNull: false,
        primaryKey: true,
        defaultValue: sequelize.literal(
          `UPPER('${baseTable}') || '-' || LPAD(nextval('${baseTable}_id_seq')::text, 4, '0')`
        ),
      },
      [detailsField]: {
        type: DataTypes.JSONB,
      },
      created_by: DataTypes.STRING,
      updated_by: DataTypes.STRING,
      is_active: {
        type: DataTypes.BOOLEAN,
        defaultValue: true,
      },
      status: DataTypes.STRING,
      api_version: DataTypes.STRING,
    },
    {
      tableName: baseTable,
      timestamps: true,
      underscored: true,
      freezeTableName: true,
    }
  );

  // History table model
  const EntityHistoryModel = sequelize.define(
    `${baseTable}_history`,
    {
      [idField]: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      [detailsField]: {
        type: DataTypes.JSONB,
      },
      updated_fields: DataTypes.JSONB,
      updated_by: DataTypes.STRING,
      status: DataTypes.STRING,
      api_version: DataTypes.STRING,
    },
    {
      tableName: `${baseTable}_history`,
      timestamps: true,
      underscored: true,
      freezeTableName: true,
    }
  );

  return {
    EntityModel,
    EntityHistoryModel,
    entityName,
    version,
  };
};
