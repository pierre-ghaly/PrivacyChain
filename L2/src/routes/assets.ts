import { Router } from 'express';
import { config } from '../config';
import type { KeyStore } from '../keyStore';
import { getAssetDetailL1, getAllAssetsDetailL1, isAdminL1, type L1AssetDetail } from '../l1Client';
import { requireAuth } from '../auth';

// Fetches and decrypts ASSET_METADATA from L3 for a given txId. L3 resolves
// the CID internally via its own index — L2 doesn't track CIDs at all.
// Returns the parsed metadata object, null if the key is destroyed (RTBF)
// or nothing was ever stored under this txId.
async function fetchL3Metadata(
  txId: string,
): Promise<{ erased: boolean; data: Record<string, unknown> | null; cid: string | null }> {
  if (!txId) return { erased: false, data: null, cid: null };

  // A bounded timeout guards against a CID that IPFS can't resolve (e.g. a
  // stale key-store entry pointing at a blob that's since been wiped) —
  // Helia's block lookup has no local answer and no peers to ask, so an
  // unresolvable CID hangs the underlying fetch indefinitely otherwise.
  let res: Response;
  try {
    res = await fetch(`${config.l3Url}/retrieve/by-tx/${txId}?dataType=ASSET_METADATA`, {
      headers: { 'X-Internal-Key': config.l3InternalKey },
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    return { erased: false, data: null, cid: null };
  }
  if (res.status === 410) return { erased: true, data: null, cid: null };
  if (!res.ok) return { erased: false, data: null, cid: null }; // includes 404 (never stored)
  const body = (await res.json()) as { data: Record<string, unknown>; cid: string };
  return { erased: false, data: body.data, cid: body.cid };
}

// Assembles the full asset object from L1 fields + L2 txId index + L3 encrypted metadata.
async function buildFullAsset(
  l1: L1AssetDetail,
  keyStore: KeyStore,
): Promise<Record<string, unknown>> {
  const txId = keyStore.getAssetTxId(l1.id.toString());
  const { erased, data: metadata, cid: metadataCid } = await fetchL3Metadata(txId ?? '');

  return {
    // --- L1: public, immutable ---
    id:         l1.id.toString(),
    name:       l1.name,
    status:     l1.status === 0 ? 'PENDING' : 'ACTIVE',
    createdAt:  l1.createdAt.toString(),
    exists:     l1.exists,
    owner:      l1.owner,
    valuations: l1.valuations.map(v => ({
      certifier:    v.certifier,
      value:        v.value.toString(),
      currencyCode: v.currencyCode,
      certifiedAt:  v.certifiedAt.toString(),
    })),
    // --- L3: encrypted, erasable ---
    metadata: erased
      ? { erased: true, note: 'Cryptographic erasure complete — RTBF exit processed.' }
      : metadata,
    // L2 index references (useful for direct L3 calls)
    txId:        txId ?? null,
    metadataCid: metadataCid ?? null,
  };
}

export function assetsRouter(keyStore: KeyStore): Router {
  const router = Router();

  // GET /assets/:assetId
  // Returns the full asset object: L1 fields + valuations + decrypted L3 metadata.
  // Gated: the asset's own owner or an admin — this returns decrypted L3
  // content, not just the public L1 fields.
  router.get('/:assetId', requireAuth, async (req, res) => {
    // req.params is over-broadly typed as string | string[] once a
    // middleware arg (requireAuth) is added before the handler — a
    // @types/express v5 vs express v4 mismatch, not a real runtime concern.
    const { assetId } = req.params as { assetId: string };

    let l1: L1AssetDetail;
    try {
      l1 = await getAssetDetailL1(assetId);
    } catch (err: any) {
      if (err?.message?.includes('Asset does not exist')) {
        res.status(404).json({ error: 'Asset not found.', assetId });
      } else {
        res.status(502).json({ error: 'Failed to fetch asset from L1.', detail: err?.message });
      }
      return;
    }

    if (!l1.exists) {
      res.status(404).json({ error: 'Asset has been burned.', assetId });
      return;
    }

    const isOwner = l1.owner.toLowerCase() === req.authAddress;
    if (!isOwner && !(await isAdminL1(req.authAddress!))) {
      res.status(403).json({ error: 'Not authorized to view this asset.' });
      return;
    }

    const asset = await buildFullAsset(l1, keyStore);
    res.json({ ok: true, asset });
  });

  // GET /assets
  // Returns full asset objects for ALL non-burned assets. Admin-only — this
  // returns decrypted L3 content for every user's assets in one call.
  router.get('/', requireAuth, async (req, res) => {
    if (!(await isAdminL1(req.authAddress!))) {
      res.status(403).json({ error: 'Admin role required.' });
      return;
    }

    let allL1: L1AssetDetail[];
    try {
      allL1 = await getAllAssetsDetailL1();
    } catch (err: any) {
      res.status(502).json({ error: 'Failed to fetch assets from L1.', detail: err?.message });
      return;
    }

    const assets = await Promise.all(allL1.map(l1 => buildFullAsset(l1, keyStore)));
    res.json({ ok: true, count: assets.length, assets });
  });

  return router;
}
