import { ethers } from 'ethers';
import { config } from './config';
import { computeErasureProofHash } from './crypto';
import type { KeyStore } from './keyStore';
import { sseManager } from './sseManager';

// A fresh ethers.Wallet computes its nonce fresh per send via the provider,
// which is not safe when performErasure runs more than once in the same
// process lifetime (e.g. two users exiting a few seconds apart) — the
// second call can race the first and reuse a stale nonce. NonceManager
// tracks nonces in-process instead, so kept as a module-level singleton
// (one per admin signer) rather than recreated per call.
//
// eventListener.ts tears down and replaces its WebSocketProvider on every
// reconnect (heartbeat failure, socket close, or the periodic forced
// resubscribe — see eventListener.ts), and passes whichever provider is
// current into performErasure each time. A signer cached against the
// *first* provider forever would silently keep using it after later
// reconnects destroy it, so recordErasureProof() would fail with
// "provider destroyed" on every call after the first reconnect — track
// which provider the cached signer was built against and rebuild it
// whenever that identity changes, rather than caching unconditionally.
let adminSigner: ethers.NonceManager | null = null;
let adminSignerProvider: ethers.WebSocketProvider | null = null;

function getAdminSigner(provider: ethers.WebSocketProvider): ethers.NonceManager {
  if (!adminSigner || adminSignerProvider !== provider) {
    adminSigner = new ethers.NonceManager(new ethers.Wallet(config.adminPrivateKey, provider));
    adminSignerProvider = provider;
  }
  return adminSigner;
}

export async function performErasure(
  user: string,
  txIds: string[],
  keyStore: KeyStore,
  provider: ethers.WebSocketProvider,
  contractAddress: string,
  contractAbi: ethers.InterfaceAbi,
): Promise<void> {
  const destroyedTxIds = keyStore.destroyKeysForUser(user);
  console.log(`[L2] Destroyed ${destroyedTxIds.length} Kr entries for user=${user}`);

  const timestamp = Math.floor(Date.now() / 1000);
  const proofHashBuffer = computeErasureProofHash(user, txIds, timestamp);
  const proofHash = ('0x' + proofHashBuffer.toString('hex')) as `0x${string}`;

  console.log(`[L2] Erasure proof hash: ${proofHash}`);

  const signer = getAdminSigner(provider);
  const contract = new ethers.Contract(contractAddress, contractAbi, signer);

  try {
    const tx = await (contract as any).recordErasureProof(user, proofHash, timestamp);
    const receipt = await tx.wait();
    console.log(`[L2] recordErasureProof confirmed (block ${receipt.blockNumber}): ${tx.hash}`);

    sseManager.push(user, 'ERASURE_COMPLETE', {
      user,
      proofHash,
      destroyedKeyCount: destroyedTxIds.length,
      txHash: tx.hash,
      timestamp,
    });
  } catch (err: any) {
    // The user may have already had a proof recorded (e.g. from seeded data replay).
    // Reset the nonce manager so a bad/stale nonce here doesn't desync every
    // subsequent erasure — the next call will re-fetch the real nonce from chain.
    signer.reset();
    console.error(`[L2] recordErasureProof failed for ${user}:`, err?.message ?? err);
  }
}
