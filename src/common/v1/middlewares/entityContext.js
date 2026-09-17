// src/common/v1/middlewares/entityContext.js

module.exports = ({ entityName, version }) => {
  return (req, res, next) => {
    const sequelize = req.app.get('sequelize');

    if (!sequelize) {
      throw new Error('Sequelize instance not found on app');
    }

    req.entityContext = {
      sequelize,
      entityName,
      version,
    };

    next();
  };
};
