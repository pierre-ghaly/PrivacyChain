import { Router } from 'express';
import type { KeyStore } from '../keyStore';

export function keysRouter(keyStore: KeyStore): Router {
  const router = Router();

  // GET /keys/:txId
  // Returns the 32-byte Kr as hex. Called by L3 to retrieve the key before decryption.
  // Returns 410 Gone if the key has been destroyed (RTBF complete).
  router.get('/:txId', (req, res) => {
    const { txId } = req.params;

    if (keyStore.isKeyDestroyed(txId)) {
      res.status(410).json({
        error: 'Key has been destroyed — RTBF erasure is complete for this transaction.',
        txId,
      });
      return;
    }

    const key = keyStore.getKey(txId);
    if (!key) {
      res.status(404).json({ error: 'Key not found for this transaction.', txId });
      return;
    }

    res.json({ txId, key: key.toString('hex') });
  });

  return router;
}
