const { Sequelize } = require('sequelize');
const config = require('../../../../config/config');

const sequelize = new Sequelize(
  config.db.database,
  config.db.user,
  String(config.db.password),
  {
    host: config.db.host,
    port: config.db.port,
    dialect: 'postgres',
    logging: false,
  }
);

module.exports = sequelize;
