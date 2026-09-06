import express from 'express';
import { config } from './config.js';
import { storeRouter } from './routes/store.js';
import { retrieveRouter } from './routes/retrieve.js';
import { imagesRouter } from './routes/images.js';
import { rekeyRouter } from './routes/rekey.js';

export function createServer(): express.Application {
  const app = express();
  app.use(express.json());

  app.use((_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Internal-Key');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    next();
  });
  app.options('*', (_req, res) => res.sendStatus(204));

  app.get('/health', (_req, res) =>
    res.json({ status: 'ok', layer: 'L3', service: 'encrypted-storage' }),
  );

  // L2 is the only intended caller for everything past this point — every
  // route requires the shared internal key. This is not a substitute for
  // real network isolation, just this demo's stand-in for it (see config.ts).
  app.use((req, res, next) => {
    if (req.headers['x-internal-key'] !== config.internalKey) {
      res.status(403).json({ error: 'Direct access to L3 is not permitted — L2 is the only caller.' });
      return;
    }
    next();
  });

  app.use('/store', storeRouter());
  app.use('/retrieve', retrieveRouter());
  app.use('/images', imagesRouter());
  app.use('/rekey', rekeyRouter());

  return app;
}
