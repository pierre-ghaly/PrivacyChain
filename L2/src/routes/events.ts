import { Router } from 'express';
import type { Request, Response } from 'express';
import { sseManager } from '../sseManager';

export function eventsRouter(): Router {
  const router = Router();

  // GET /events?user=0x...
  // Opens a Server-Sent Events stream for a specific user address.
  // Events pushed:
  //   KEY_READY      { txId, purpose, user, [assetId, assetName] }
  //   ERASURE_COMPLETE { user, proofHash, destroyedKeyCount, txHash, timestamp }
  router.get('/', (req: Request, res: Response) => {
    const user = (req.query.user as string | undefined)?.toLowerCase();
    if (!user) {
      res.status(400).json({ error: 'user query param required (Ethereum address).' });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering if present
    res.flushHeaders();

    // Initial heartbeat so the client knows the stream is open
    res.write(': connected\n\n');

    sseManager.add(user, res);

    // Heartbeat every 25 s to keep the connection alive through proxies
    const heartbeat = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { clearInterval(heartbeat); }
    }, 25_000);

    req.on('close', () => {
      clearInterval(heartbeat);
      sseManager.remove(user, res);
    });
  });

  return router;
}
