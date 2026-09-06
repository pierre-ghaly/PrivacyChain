import { config } from './config';

export interface RekeyResult {
  metadataCid: string;
  imageCids: string[];
}

export interface ProxyResult {
  status: number;
  body: any;
}

// These three never throw on an HTTP-level error — they mirror L3's real
// status code (400/410/404/200) back to the caller so the L2 route handler
// can pass it straight through, same as assets.ts's fetchL3Metadata already
// does for its 410 case.
async function proxy(path: string, init?: RequestInit): Promise<ProxyResult> {
  const res = await fetch(`${config.l3Url}${path}`, {
    ...init,
    headers: { ...init?.headers, 'X-Internal-Key': config.l3InternalKey },
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

export function storeData(params: { txId: string; dataType: string; data: unknown }): Promise<ProxyResult> {
  return proxy('/store', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
}

export function storeImage(params: { txId: string; imageData: string; mimeType?: string }): Promise<ProxyResult> {
  return proxy('/images', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
}

export function retrieveData(cid: string, txId: string): Promise<ProxyResult> {
  return proxy(`/retrieve/${cid}?txId=${txId}`);
}

// Resolves data by (txId, dataType) instead of a raw CID — L3 looks the CID
// up in its own index internally, so L2 never needs to track one. This is
// the metadata lookup path; images stay CID-addressed via retrieveData
// above, since one txId can reference several image CIDs.
export function retrieveByTx(txId: string, dataType: string): Promise<ProxyResult> {
  return proxy(`/retrieve/by-tx/${txId}?dataType=${dataType}`);
}

// Asks L3 to re-encrypt a blob (and, for ASSET_METADATA, any embedded
// images) from the old txId's key to the new txId's key. L3 fetches both
// keys itself via its existing GET /keys/:txId client (L3/src/l2Client.ts)
// — L2 never needs to transmit key material — and resolves the old CID
// itself from its own index, so L2 only ever points it at txIds, never CIDs.
// Returns null if L3 has nothing stored under oldTxId yet (nothing to
// migrate — e.g. seed.ts transfers assets before seeding their metadata).
export async function rekeyMetadata(params: {
  oldTxId: string;
  newTxId: string;
  dataType: string;
}): Promise<RekeyResult | null> {
  const { status, body } = await proxy('/rekey', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (status === 404) return null;
  if (status < 200 || status >= 300) {
    throw new Error(`L3 rekey failed: HTTP ${status}`);
  }
  return body as RekeyResult;
}
