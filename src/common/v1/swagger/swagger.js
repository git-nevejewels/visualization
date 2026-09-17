const swaggerJSDoc = require('swagger-jsdoc');
require('dotenv').config();

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Neve Jewels Visualization API',
      version: '1.0.0',
      description: 'Entity-based API framework',
    },
    servers: [
      {
        url: `http://localhost:${process.env.PORT || 3000}`,
      },
    ],
  },

  // 🔥 This is IMPORTANT
  apis: [
    './src/entities/**/routes/*.js',
  ],
};

module.exports = swaggerJSDoc(options);
