import { Router, type Response } from 'express';
import { getBytes } from '../ipfs.js';
import { decryptData } from '../crypto.js';
import { fetchKey } from '../l2Client.js';
import { getCid } from '../cidStore.js';

// Shared by both routes below:
//   1. Fetch encrypted blob from Helia IPFS by CID  (always succeeds — IPFS is immutable)
//   2. Fetch Kr from L2 for the given txId
//   3a. If key exists → decrypt → return plaintext JSON
//   3b. If key is destroyed (410) → return 410 with the raw CID
//       (demonstrates that the blob exists but is computationally inaccessible)
async function respondWithDecrypted(
  res: Response,
  cid: string,
  txId: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  // Always fetch from the store first — demonstrates the blob still exists
  let encryptedBlob: Buffer;
  try {
    encryptedBlob = await getBytes(cid);
  } catch {
    res.status(404).json({ error: 'CID not found in local IPFS store.', cid });
    return;
  }

  const key = await fetchKey(txId);
  if (!key) {
    // Key destroyed — cryptographic erasure complete.
    // The blob is still on IPFS (pinned), but permanently unreadable.
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
  // to know or handle a raw CID for the metadata case. L3 is fully
  // self-contained for this lookup — L2 no longer tracks CIDs at all.
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
