import swaggerJsdoc from 'swagger-jsdoc';
import swaggerUi from 'swagger-ui-express';
import { Express } from 'express';
import path from 'path';

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'FinTrack API',
      version: '1.0.0',
      description: 'FinTrack backend API documentation\n\n> **OpenAPI JSON** (Postman / Insomnia import): [`/api-docs/openapi.json`](/api-docs/openapi.json)',
    },
    externalDocs: {
      description: 'Download OpenAPI JSON (Postman / Insomnia import)',
      url: '/api-docs/openapi.json',
    },
    servers: [{ url: '/api' }],
  },
  apis: [
    path.join(process.cwd(), 'src/modules/**/*.controller.ts'),
    path.join(process.cwd(), 'src/common/lib/swagger/swagger.yaml'),
  ],
};

export function setupSwagger(app: Express): void {
  const swaggerSpec = swaggerJsdoc(options);

  // Expose the raw spec so clients can download it for Postman / Insomnia
  app.get('/api-docs/openapi.json', (_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.json(swaggerSpec);
  });

  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
    swaggerOptions: { persistAuthorization: true },
  }));
}
