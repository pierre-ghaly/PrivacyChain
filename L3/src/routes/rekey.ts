import { Router } from 'express';
import { getBytes, pinBytes } from '../ipfs.js';
import { encryptData, decryptData } from '../crypto.js';
import { fetchKey } from '../l2Client.js';
import { getCid, storeCid } from '../cidStore.js';
import type { AssetMetadata } from '../types.js';

export function rekeyRouter(): Router {
  const router = Router();

  // POST /rekey
  // Body: { oldTxId, newTxId, dataType }
  //
  // Re-encrypts a blob (and, for ASSET_METADATA, any embedded images) from
  // the old owner's key to the new owner's key, triggered by L2 in response
  // to AssetTransferred or an exit-time disposition. Both keys are fetched
  // from L2 the normal way (GET /keys/:txId) — no key material is ever
  // passed in the request. The old CID is resolved internally via L3's own
  // index — L2 doesn't track CIDs at all, it only knows txIds.
  //
  // Flow:
  //   1. Resolve oldCid from L3's own index for (oldTxId, dataType) — 404 if
  //      nothing was ever stored under oldTxId (nothing to migrate)
  //   2. Fetch old + new Kr from L2
  //   3. Fetch the old encrypted blob from IPFS, decrypt with old Kr
  //   4. For each image CID referenced in metadata: fetch, decrypt (old Kr),
  //      re-encrypt (new Kr), re-pin — collect new CIDs
  //   5. Re-encrypt the metadata (with updated imageCids) under new Kr, pin,
  //      and register the new (newTxId, dataType) -> CID mapping locally
  //   6. Return the new metadata CID + new image CIDs
  //
  // The old blob(s) are left exactly as they are — IPFS never deletes —
  // they simply become unreferenced once L2 repoints asset_txids.
  router.post('/', async (req, res) => {
    const { oldTxId, newTxId, dataType } = req.body as {
      oldTxId?: string;
      newTxId?: string;
      dataType?: string;
    };

    if (!oldTxId || !newTxId || !dataType) {
      res.status(400).json({ error: 'oldTxId, newTxId, and dataType are required.' });
      return;
    }

    const oldCid = getCid(oldTxId, dataType);
    if (!oldCid) {
      res.status(404).json({ error: 'No data stored for this (oldTxId, dataType) pair — nothing to migrate.', oldTxId, dataType });
      return;
    }

    const oldKey = await fetchKey(oldTxId);
    if (!oldKey) {
      res.status(410).json({ error: 'Old key not available.', oldTxId });
      return;
    }
    const newKey = await fetchKey(newTxId);
    if (!newKey) {
      res.status(410).json({ error: 'New key not available.', newTxId });
      return;
    }

    let metadata: AssetMetadata;
    try {
      const encryptedBlob = await getBytes(oldCid);
      metadata = JSON.parse(decryptData(encryptedBlob, oldKey).toString('utf8'));
    } catch {
      res.status(500).json({ error: 'Failed to fetch or decrypt metadata at oldCid.', oldCid });
      return;
    }

    const newImageCids: string[] = [];
    for (const oldImageCid of metadata.imageCids ?? []) {
      const imgBlob = await getBytes(oldImageCid);
      const imgPlain = decryptData(imgBlob, oldKey);
      const reencrypted = encryptData(imgPlain, newKey);
      newImageCids.push(await pinBytes(reencrypted));
    }

    const newMetadata: AssetMetadata = {
      ...metadata,
      ...(metadata.imageCids ? { imageCids: newImageCids } : {}),
    };
    const newMetadataBlob = encryptData(Buffer.from(JSON.stringify(newMetadata), 'utf8'), newKey);
    const metadataCid = await pinBytes(newMetadataBlob);
    storeCid(newTxId, dataType, metadataCid);

    console.log(`[L3] Rekeyed metadata ${oldCid} -> ${metadataCid} (${newImageCids.length} image(s))`);
    res.json({ ok: true, metadataCid, imageCids: newImageCids });
  });

  return router;
}
