import { Router, type Response } from 'express';
import { getBytes } from '../ipfs.js';
import { decryptData } from '../crypto.js';
import { fetchKey } from '../l2Client.js';
import { getCid } from '../cidStore.js';

// Shared by both routes below. The blob is fetched before the key, on
// purpose: even once Kr is destroyed (410), this still proves the
// encrypted blob remains on IPFS — cryptographic erasure, not deletion.
async function respondWithDecrypted(
  res: Response,
  cid: string,
  txId: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  let encryptedBlob: Buffer;
  try {
    encryptedBlob = await getBytes(cid);
  } catch {
    res.status(404).json({ error: 'CID not found in local IPFS store.', cid });
    return;
  }

  const key = await fetchKey(txId);
  if (!key) {
    res.status(410).json({
      error: 'Cryptographic erasure complete — decryption key has been destroyed.',
      cid,
      txId,
      note: 'The encrypted blob still exists on IPFS but is computationally inaccessible.',
    });
    return;
  }

  try {
    const plaintext = decryptData(encryptedBlob, key);
    const data = JSON.parse(plaintext.toString('utf8'));
    res.json({ ok: true, cid, txId, ...extra, data });
  } catch {
    res.status(500).json({ error: 'Decryption failed — data may be corrupted.' });
  }
}

export function retrieveRouter(): Router {
  const router = Router();

  // GET /retrieve/:cid?txId=<txId>
  // By-CID lookup — the only option for images, since one txId can
  // reference several image CIDs (no dataType-level uniqueness for them).
  router.get('/:cid', async (req, res) => {
    const { cid } = req.params;
    const txId = req.query.txId as string | undefined;

    if (!txId) {
      res.status(400).json({ error: 'txId query param is required.' });
      return;
    }

    await respondWithDecrypted(res, cid, txId);
  });

  // GET /retrieve/by-tx/:txId?dataType=USER_PII|ASSET_METADATA
  // Resolves the CID internally via L3's own index, so callers never need
  // to know or handle a raw CID for the metadata case — L2 doesn't track
  // CIDs at all, only txIds.
  router.get('/by-tx/:txId', async (req, res) => {
    const { txId } = req.params;
    const dataType = req.query.dataType as string | undefined;

    if (!dataType) {
      res.status(400).json({ error: 'dataType query param is required.' });
      return;
    }

    const cid = getCid(txId, dataType);
    if (!cid) {
      res.status(404).json({ error: 'No data stored for this (txId, dataType) pair.', txId, dataType });
      return;
    }

    await respondWithDecrypted(res, cid, txId, { dataType });
  });

  return router;
}
