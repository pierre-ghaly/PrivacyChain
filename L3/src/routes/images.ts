import { Router } from 'express';
import { pinBytes } from '../ipfs.js';
import { encryptData } from '../crypto.js';
import { fetchKey } from '../l2Client.js';

export function imagesRouter(): Router {
  const router = Router();

  // POST /images
  // Encrypts a binary image under the asset's Kr (same key as ASSET_METADATA)
  // and pins it to Helia IPFS. The returned CID should be added to the
  // asset's ASSET_METADATA imageCids list by the caller.
  //
  // Body:
  //   txId      — the asset creation transactionId (used to look up Kr in L2)
  //   imageData — base64-encoded image bytes
  //   mimeType  — optional MIME type hint (e.g. "image/jpeg"), stored alongside the data
  //
  // Images aren't registered in L3's CID index — they're referenced only
  // from within the encrypted ASSET_METADATA blob, so destroying the shared
  // Kr on RTBF exit makes them inaccessible alongside the metadata too.
  router.post('/', async (req, res) => {
    const { txId, imageData, mimeType } = req.body as {
      txId?: string;
      imageData?: string;
      mimeType?: string;
    };

    if (!txId || !imageData) {
      res.status(400).json({ error: 'txId and imageData (base64) are required.' });
      return;
    }

    let imageBuffer: Buffer;
    try {
      imageBuffer = Buffer.from(imageData, 'base64');
      if (imageBuffer.length === 0) throw new Error('Empty image');
    } catch {
      res.status(400).json({ error: 'imageData must be valid base64-encoded bytes.' });
      return;
    }

    const key = await fetchKey(txId);
    if (!key) {
      res.status(410).json({
        error: 'Key not available — either not yet derived or already destroyed.',
        txId,
      });
      return;
    }

    // Wrap image bytes and optional MIME type into a small JSON envelope before
    // encrypting so the decrypted blob is self-describing.
    const envelope = JSON.stringify({
      mimeType: mimeType ?? 'application/octet-stream',
      data: imageData,
    });
    const encryptedBlob = encryptData(Buffer.from(envelope, 'utf8'), key);
    const cid = await pinBytes(encryptedBlob);

    console.log(`[L3] Stored image for txId=${txId} → CID=${cid}`);
    res.json({ ok: true, txId, cid });
  });

  return router;
}
