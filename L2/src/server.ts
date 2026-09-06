import express from 'express';
import { keysRouter } from './routes/keys';
import { eventsRouter } from './routes/events';
import { statusRouter } from './routes/status';
import { assetsRouter } from './routes/assets';
import { authRouter } from './routes/auth';
import { l3ProxyRouter } from './routes/l3proxy';
import type { KeyStore } from './keyStore';

export function createServer(keyStore: KeyStore): express.Application {
  const app = express();
  app.use(express.json());

  // Permissive CORS — all origins allowed (localhost dev only)
  app.use((_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    next();
  });
  app.options('*', (_req, res) => res.sendStatus(204));

  app.get('/health', (_req, res) =>
    res.json({ status: 'ok', layer: 'L2', service: 'key-management' }),
  );

  app.use('/keys', keysRouter(keyStore));
  app.use('/events', eventsRouter());
  app.use('/status', statusRouter(keyStore));
  app.use('/assets', assetsRouter(keyStore));
  app.use('/auth', authRouter());
  app.use('/l3', l3ProxyRouter(keyStore));

  return app;
}
