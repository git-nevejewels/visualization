const fs = require('fs');
const path = require('path');
const loadModels = require('./modelLoader');
const loadRoutes = require('./routeLoader');
const sequelize = require('../db/sequelize'); // ✅ OWN sequelize here

const loadEntities = (app) => {
  const entitiesPath = path.join(__dirname, '../../../entities');

  fs.readdirSync(entitiesPath).forEach(entityName => {
    const entityPath = path.join(entitiesPath, entityName);
    if (!fs.statSync(entityPath).isDirectory()) return;

    fs.readdirSync(entityPath).forEach(version => {
      const versionPath = path.join(entityPath, version);

      if (!fs.existsSync(path.join(versionPath, 'models'))) return;

      console.log(`📦 Loading ${entityName} ${version}`);

      // 1️⃣ Load Models (ENTITY ONLY)
      loadModels({
        sequelize,
        entityName,
        version,
        versionPath,
      });

      // 2️⃣ Load Routes
      loadRoutes({
        app,
        entityName,
        version,
        versionPath,
      });
    });
  });
};

module.exports = {
  loadEntities,
  sequelize, // ✅ exported for server.js sync
};
