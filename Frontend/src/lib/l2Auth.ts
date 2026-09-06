import { L2_SERVER_URL } from "@/contracts";

type SignMessageAsync = (args: { message: string }) => Promise<string>;

interface CachedSession {
  address: string;
  signature: string;
  expiresAt: number;
}

// Module-level, not persisted — fine to lose on refresh, getAuthHeader just
// re-signs lazily. Every L2 data-plane call (the /l3/* gateway routes and
// the /assets reads) needs this header.
let cached: CachedSession | null = null;

const EXPIRY_SAFETY_MARGIN_MS = 5000;

// Returns an `Authorization: <address> <signature>` header value, signing a
// fresh session with the connected wallet only when the cached one is
// missing, expired, or for a different address.
export async function getAuthHeader(address: string, signMessageAsync: SignMessageAsync): Promise<string> {
  const lower = address.toLowerCase();
  if (cached && cached.address === lower && Date.now() < cached.expiresAt - EXPIRY_SAFETY_MARGIN_MS) {
    return `${address} ${cached.signature}`;
  }

  const nonceRes = await fetch(`${L2_SERVER_URL}/auth/nonce?address=${address}`);
  if (!nonceRes.ok) {
    throw new Error(`Failed to fetch auth nonce: HTTP ${nonceRes.status}`);
  }
  const { message, expiresAt } = await nonceRes.json() as { message: string; expiresAt: number };

  const signature = await signMessageAsync({ message });
  cached = { address: lower, signature, expiresAt };
  return `${address} ${signature}`;
}
