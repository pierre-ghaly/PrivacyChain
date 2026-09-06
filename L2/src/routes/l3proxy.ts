import { Router } from 'express';
import type { KeyStore } from '../keyStore';
import { requireAuth } from '../auth';
import { isAdminL1 } from '../l1Client';
import { storeData, storeImage, retrieveData, retrieveByTx } from '../l3Client';

// The only path the Frontend uses to reach L3 — never directly. Every route
// here requires a valid signed session (requireAuth) and an ownership check
// before it will forward anything.
export function l3ProxyRouter(keyStore: KeyStore): Router {
  const router = Router();

  router.post('/store', requireAuth, async (req, res) => {
    const { txId, dataType, data } = req.body as { txId?: string; dataType?: string; data?: unknown };
    if (!txId || !dataType || data === undefined) {
      res.status(400).json({ error: 'txId, dataType, and data are required.' });
      return;
    }
    const owner = keyStore.getKeyOwner(txId);
    if (!owner || owner !== req.authAddress) {
      res.status(403).json({ error: 'Not authorized to write this transaction.' });
      return;
    }
    const { status, body } = await storeData({ txId, dataType, data });
    res.status(status).json(body);
  });

  router.post('/images', requireAuth, async (req, res) => {
    const { txId, imageData, mimeType } = req.body as { txId?: string; imageData?: string; mimeType?: string };
    if (!txId || !imageData) {
      res.status(400).json({ error: 'txId and imageData (base64) are required.' });
      return;
    }
    const owner = keyStore.getKeyOwner(txId);
    if (!owner || owner !== req.authAddress) {
      res.status(403).json({ error: 'Not authorized to write this transaction.' });
      return;
    }
    const { status, body } = await storeImage({ txId, imageData, mimeType });
    res.status(status).json(body);
  });

  router.get('/retrieve/:cid', requireAuth, async (req, res) => {
    // req.params is over-broadly typed as string | string[] once a
    // middleware arg (requireAuth) is added before the handler — a
    // @types/express v5 vs express v4 mismatch, not a real runtime concern.
    const { cid } = req.params as { cid: string };
    const txId = req.query.txId as string | undefined;
    if (!txId) {
      res.status(400).json({ error: 'txId query param is required.' });
      return;
    }
    const owner = keyStore.getKeyOwner(txId);
    const isOwner = !!owner && owner === req.authAddress;
    if (!isOwner && !(await isAdminL1(req.authAddress!))) {
      res.status(403).json({ error: 'Not authorized to read this transaction.' });
      return;
    }
    const { status, body } = await retrieveData(cid, txId);
    res.status(status).json(body);
  });

  // GET /l3/data/:txId?dataType=USER_PII|ASSET_METADATA
  // Metadata lookup by txId, not CID — replaces the old two-step
  // (GET /keys/cids/:txId then GET /l3/retrieve/:cid) flow with one call.
  // Owner-only: currently only used for a user viewing their own PII.
  router.get('/data/:txId', requireAuth, async (req, res) => {
    // req.params is over-broadly typed as string | string[] once a
    // middleware arg (requireAuth) is added before the handler — a
    // @types/express v5 vs express v4 mismatch, not a real runtime concern.
    const { txId } = req.params as { txId: string };
    const dataType = req.query.dataType as string | undefined;
    if (!dataType) {
      res.status(400).json({ error: 'dataType query param is required.' });
      return;
    }
    const owner = keyStore.getKeyOwner(txId);
    if (!owner || owner !== req.authAddress) {
      res.status(403).json({ error: 'Not authorized to view this transaction.' });
      return;
    }
    const { status, body } = await retrieveByTx(txId, dataType);
    res.status(status).json(body);
  });

  return router;
}
