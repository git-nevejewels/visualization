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
    pool: { min: 2, max: 10, idle: 30000 },
  }
);

module.exports = sequelize;
