// src/common/v1/loaders/routeLoader.js
const path = require('path');
const fs = require('fs');

module.exports = ({ app, entityName, version, versionPath }) => {
  const routesFile = path.join(
    versionPath,
    'routes',
    'entityRoutes.js'
  );

  // Skip if routes file does not exist
  if (!fs.existsSync(routesFile)) {
    console.warn(
      `⚠️  No routes found for ${entityName}/${version}`
    );
    return;
  }

  const router = require(routesFile);

  const mountPath = `/api/${entityName}/${version}`;

  // 🔑 Inject entity context into every request
  app.use(
    mountPath,
    (req, res, next) => {
      req.entityContext = {
        entityName,
        version,
      };
      next();
    },
    router
  );

  console.log(`✅ Routes mounted: ${mountPath}`);
};
