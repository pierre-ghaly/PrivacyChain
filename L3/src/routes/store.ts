import { Router } from 'express';
import { pinBytes } from '../ipfs.js';
import { encryptData } from '../crypto.js';
import { fetchKey } from '../l2Client.js';
import { storeCid } from '../cidStore.js';

export function storeRouter(): Router {
  const router = Router();

  // POST /store
  // Body: { txId: string, dataType: "USER_PII" | "ASSET_METADATA" | "VALUATION" | "SALE_PRICE", data: object }
  //
  // Supported schemas (see src/types.ts for full TypeScript types):
  //
  //   USER_PII:
  //     { realName: string, email: string, address?: string }
  //
  //   ASSET_METADATA:
  //     {
  //       description: string,          — human-readable asset description
  //       category?: string,            — e.g. "Real Estate", "Vehicle", "Artwork"
  //       metadata?: Record<string,string>, — open key-value pairs (location, size, year, …)
  //       imageCids?: string[]          — CIDs of encrypted image blobs (from POST /images)
  //     }
  //
  //   VALUATION / SALE_PRICE — content behind a requestFinancialAssertion() txId minted
  //   on L1 (no counterparty for VALUATION, buyer address for SALE_PRICE); L2 tracks the
  //   PENDING/CONFIRMED/APPROVED/REJECTED lifecycle, not L3:
  //     { value: string, currencyCode: string, entity?: string }
  router.post('/', async (req, res) => {
    const { txId, dataType, data } = req.body as {
      txId?: string;
      dataType?: string;
      data?: unknown;
    };

    if (!txId || !dataType || data === undefined) {
      res.status(400).json({ error: 'txId, dataType, and data are required.' });
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

    const plaintext = Buffer.from(JSON.stringify(data), 'utf8');
    const encryptedBlob = encryptData(plaintext, key);
    const cid = await pinBytes(encryptedBlob);

    storeCid(txId, dataType, cid);

    console.log(`[L3] Stored ${dataType} for txId=${txId} → CID=${cid}`);
    res.json({ ok: true, txId, dataType, cid });
  });

  return router;
}
