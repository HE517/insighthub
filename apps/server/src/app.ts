/**
 * Express HTTP application.
 *
 * M0 scope: a single `/health` probe. Document APIs, auth and permissions
 * arrive in M1+ (see docs/TASKS.md).
 */
import cors from 'cors';
import express, { type Express, type Request, type Response } from 'express';

import { type ServerConfig } from './config.js';

export function createApp(config: ServerConfig): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(cors({ origin: config.corsOrigin }));
  app.use(express.json({ limit: '1mb' }));

  /** Liveness probe. Must return 200 for the M0 acceptance criteria. */
  app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'ok' });
  });

  /** Tiny discovery endpoint so a browser can find the WS URL without guessing. */
  app.get('/api/meta', (_req: Request, res: Response) => {
    res.status(200).json({
      name: 'insighthub-server',
      wsPath: config.wsPath,
      protocolVersion: 1,
    });
  });

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'not_found' });
  });

  return app;
}
