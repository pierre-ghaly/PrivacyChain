import type { KeyStore } from './keyStore';
import { rekeyMetadata } from './l3Client';

// Triggered from AssetTransferred. The new owner's Kr already exists by the
// time this runs (eventListener.ts derives it via storeKey before calling
// in). This re-encrypts the asset's metadata (and any images) from the
// previous owner's key to the new owner's key, so a later exit by a former
// owner can never affect an asset they no longer hold.
export async function rekeyAsset(
  assetId: string,
  newTxId: string,
  keyStore: KeyStore,
): Promise<void> {
  const oldTxId = keyStore.getAssetTxId(assetId);
  if (!oldTxId || oldTxId === newTxId) return;

  try {
    const result = await rekeyMetadata({ oldTxId, newTxId, dataType: 'ASSET_METADATA' });
    if (result === null) {
      // No metadata has been stored under the old txId yet — e.g. seed.ts,
      // which performs all its transfers before seeding L3 metadata at the
      // end of the run (so at transfer time there's nothing to migrate; the
      // metadata it seeds afterwards lands under whatever txId asset_txids
      // still points to). Nothing to migrate here.
      console.log(`[L2] Rekey skipped for assetId=${assetId}: no ASSET_METADATA under txId=${oldTxId}`);
      return;
    }
    keyStore.setAssetTxId(assetId, newTxId);
    console.log(
      `[L2] Rekeyed assetId=${assetId}: txId ${oldTxId}->${newTxId}, ` +
      `metadataCid -> ${result.metadataCid}, ${result.imageCids.length} image(s)`,
    );
  } catch (err: any) {
    console.error(
      `[L2] Rekey failed for assetId=${assetId} (txId ${oldTxId}->${newTxId}):`,
      err?.message ?? err,
    );
    // asset_txids stays at oldTxId — nothing becomes unreadable. No retry/queue.
  }
}
