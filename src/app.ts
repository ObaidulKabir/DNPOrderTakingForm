import cors from 'cors';
import express, { Express } from 'express';
import path from 'node:path';
import { createContainer, ServiceContainer } from './container.js';
import { createApiRouter } from './routes/apiRoutes.js';

export function createApp(container: ServiceContainer = createContainer()): Express {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '5mb' }));

  const publicDir = path.resolve(process.cwd(), 'public');
  app.use(express.static(publicDir));

  app.use('/api', createApiRouter(container));

  return app;
}
