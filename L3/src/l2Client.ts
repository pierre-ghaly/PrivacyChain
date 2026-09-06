import { config } from './config.js';

// Fetches the 32-byte Kr for a given txId from L2.
// Returns null if the key has been destroyed (410) or not yet derived (404).
export async function fetchKey(txId: string): Promise<Buffer | null> {
  const res = await fetch(`${config.l2Url}/keys/${txId}`);

  if (res.status === 410) {
    // Key has been destroyed — RTBF erasure is complete
    return null;
  }
  if (res.status === 404) {
    return null;
  }
  if (!res.ok) {
    throw new Error(`L2 key fetch failed: HTTP ${res.status}`);
  }

  const { key } = (await res.json()) as { key: string };
  return Buffer.from(key, 'hex');
}
