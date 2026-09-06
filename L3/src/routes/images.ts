import { Router } from 'express';
import { pinBytes } from '../ipfs.js';
import { encryptData } from '../crypto.js';
import { fetchKey } from '../l2Client.js';

export function imagesRouter(): Router {
  const router = Router();

  // POST /images
  // Encrypts a binary image under the asset's Kr and pins it to Helia IPFS.
  // The returned CID should be added to the asset's ASSET_METADATA imageCids list.
  //
  // Body:
  //   txId      — the asset creation transactionId (used to look up Kr in L2)
  //   imageData — base64-encoded image bytes
  //   mimeType  — optional MIME type hint (e.g. "image/jpeg"), stored alongside the data
  //
  // Flow:
  //   1. Decode base64 imageData to Buffer
  //   2. Fetch Kr from L2 using txId (same key used for ASSET_METADATA)
  //   3. Encrypt image bytes with AES-256-GCM using Kr
  //   4. Pin encrypted blob to Helia → get CID
  //   5. Return CID to caller — add it to imageCids in ASSET_METADATA
  //
  // Images are NOT registered in L2's CID index; they are referenced only
  // within the encrypted ASSET_METADATA blob.  On RTBF exit, the shared Kr
  // is destroyed so all images become inaccessible alongside the metadata.
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
