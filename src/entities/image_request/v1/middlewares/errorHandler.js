// src/entities/image_request/v1/middlewares/errorHandler.js
// Entity-level error handler — delegates to the global error handler in common.
// Keep this file for backward compatibility but it simply calls next(err).

module.exports = function errorHandler(err, req, res, next) {
  next(err);
};
