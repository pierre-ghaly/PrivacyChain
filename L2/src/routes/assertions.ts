import { Router } from 'express';
import type { KeyStore } from '../keyStore';
import { requireAuth } from '../auth';
import { isAdminL1 } from '../l1Client';
import { retrieveByTx } from '../l3Client';

// Read-only route for financial assertions (valuations, sale-price
// proposals) — no approve/reject/confirm here. Both are on-chain: admin's
// decision (AssetRegistry.decideFinancialAssertion) and each party's
// confirmation (AssetRegistry.confirmFinancialAssertion), reacted to by
// eventListener.ts's onFinancialAssertionDecided/onFinancialAssertionConfirmed,
// not routes in this file.
export function assertionsRouter(keyStore: KeyStore): Router {
  const router = Router();

  // GET /assertions?assetId=
  //   admin, no assetId  -> the review queue (PENDING, oldest first)
  //   admin, with assetId -> every assertion for that asset, any status
  //   non-admin           -> only rows where the caller is submittedBy or
  //                          counterparty (optionally further filtered by assetId)
  // Each row enriched with its decrypted L3 content — this is what closes
  // the counterparty's read-access gap: GET /l3/data/:txId is owner-only,
  // so a buyer (never the owner of a seller-submitted assertion's txId)
  // would otherwise have no way to see a proposed price at all. Authorizing
  // via the financial_assertions row here, not owner-only, is deliberate.
  router.get('/', requireAuth, async (req, res) => {
    const assetId = req.query.assetId as string | undefined;
    const isAdmin = await isAdminL1(req.authAddress!);

    let rows;
    if (isAdmin) {
      rows = assetId ? keyStore.listAssertionsForAsset(assetId) : keyStore.listPendingAssertions();
    } else {
      rows = keyStore.listAssertionsForUser(req.authAddress!);
      if (assetId) rows = rows.filter(r => r.assetId === assetId);
    }

    const assertions = await Promise.all(rows.map(async (row) => {
      // dataType is derived from counterparty presence, not stored — see
      // keyStore.ts's note on why there's no assertionType column.
      const dataType = row.counterparty ? 'SALE_PRICE' : 'VALUATION';
      const { status, body } = await retrieveByTx(row.txId, dataType);
      return {
        ...row,
        data: status === 200 ? body.data : null,
        erased: status === 410,
      };
    }));

    res.json({ ok: true, assertions });
  });

  return router;
}
