const path = require('path');
const fs = require('fs');

module.exports = ({ sequelize, entityName, version, versionPath }) => {
  const modelFile = path.join(
    versionPath,
    'models',
    'entityModel.js'
  );

  // No models defined for this version
  if (!fs.existsSync(modelFile)) return;

  const baseModelName = `${entityName.toLowerCase()}_${version}`;
  const historyModelName = `${baseModelName}_history`;
  const baseTableSequenceName = `${entityName.toLowerCase()}_id_seq`;

  // ⛔ Prevent re-definition (VERY IMPORTANT)
  if (
    sequelize.models[baseModelName] &&
    sequelize.models[historyModelName]
  ) {
    return;
  }

  try {
    // ✅ Create sequence if not exists
    sequelize.query(`
      CREATE SEQUENCE IF NOT EXISTS ${baseTableSequenceName} START 1;
    `);
  } catch (err) {
    console.error(`Error creating sequence for ${baseTable}:`, err);
    throw err;
  }

  /**
   * entityModel.js MUST:
   *  - call sequelize.define(baseModelName, ...)
   *  - call sequelize.define(historyModelName, ...)
   */
  const defineModels = require(modelFile);

  defineModels(sequelize, entityName, version);
};
