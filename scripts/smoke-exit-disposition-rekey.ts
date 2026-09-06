/**
 * Smoke test for exit-time disposition re-keying (TRANSFER_TO_USER / BURN).
 *
 * Complements scripts/smoke-transfer-rekey.ts (voluntary transferAsset()).
 * This one exercises the exit path: Carol disposes her asset to Dave via
 * TRANSFER_TO_USER on exit — the disposition must re-key like a normal
 * transfer, not silently erase the data like a burn would. Then Dave burns
 * on his own exit, and the data must actually be gone.
 *
 *   npx tsx scripts/smoke-exit-disposition-rekey.ts
 *
 * Uses Hardhat accounts #6/#7 (untouched by seed.ts and by
 * smoke-transfer-rekey.ts, which uses #4/#5) so this can run back-to-back
 * with that script against the same live stack.
 */
import { ethers } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');
const L1_URL = 'http://127.0.0.1:8545';
const L2_URL = process.env.L2_URL ?? 'http://127.0.0.1:3001';
const L3_URL = process.env.L3_URL ?? 'http://127.0.0.1:3002';
// This script calls L3 directly (bypassing L2's /l3/* proxy) to isolate the
// rekey behavior under test — L3 requires this on every route but /health.
const L3_INTERNAL_KEY = process.env.L3_INTERNAL_KEY ?? 'dev-only-l2-l3-shared-secret-change-in-production';
const l3Headers = { 'X-Internal-Key': L3_INTERNAL_KEY };

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) {
    console.log(`  OK   ${msg}`);
  } else {
    failures++;
    console.error(`  FAIL ${msg}`);
  }
}

function loadDeployment(): { address: string; abi: any } {
  const raw = fs.readFileSync(path.join(ROOT, 'shared', 'deployments', 'localhost.json'), 'utf8');
  return JSON.parse(raw).contracts.AssetRegistry;
}

async function waitFor<T>(label: string, fn: () => Promise<T | null>, timeoutMs = 15_000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await fn();
    if (result !== null) return result;
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

function extractEvent(iface: ethers.Interface, rcpt: ethers.ContractTransactionReceipt, name: string): ethers.LogDescription {
  const parsed = rcpt.logs
    .map(l => { try { return iface.parseLog(l); } catch { return null; } })
    .find(p => p && p.name === name);
  if (!parsed) throw new Error(`Event ${name} not found in receipt`);
  return parsed;
}

// GET /assets/:id is auth-gated (owner or admin) — sign in as admin once and
// reuse for every such check in this script, since admin can view any asset
// regardless of current owner.
async function getAuthHeader(signer: ethers.Signer): Promise<string> {
  const address = await signer.getAddress();
  const res = await fetch(`${L2_URL}/auth/nonce?address=${address}`);
  const { message } = await res.json() as { message: string };
  const signature = await signer.signMessage(message);
  return `${address} ${signature}`;
}

const InactivePolicy = { TRANSFER_TO_SYSTEM: 0, TRANSFER_TO_USER: 1, BURN: 2 } as const;

async function main() {
  const provider = new ethers.JsonRpcProvider(L1_URL);
  const admin = await provider.getSigner(0);
  const carol = await provider.getSigner(6);
  const dave = await provider.getSigner(7);
  console.log(`admin=${await admin.getAddress()} carol=${await carol.getAddress()} dave=${await dave.getAddress()}`);
  const adminAuth = await getAuthHeader(admin);

  const { address, abi } = loadDeployment();
  const iface = new ethers.Interface(abi);
  const registry = new ethers.Contract(address, abi, provider);

  const carolAddr = (await carol.getAddress()).toLowerCase();
  const daveAddr = (await dave.getAddress()).toLowerCase();

  console.log('\n== Setup: register + approve Carol and Dave ==');
  await (await (registry.connect(carol) as any).registerUser()).wait();
  await (await (registry.connect(admin) as any).approveUser(carolAddr)).wait();
  await (await (registry.connect(dave) as any).registerUser()).wait();
  await (await (registry.connect(admin) as any).approveUser(daveAddr)).wait();

  console.log('\n== Carol creates an asset with metadata ==');
  const createRcpt = await (await (registry.connect(carol) as any).createAsset('Exit Disposition Test Asset')).wait();
  const created = extractEvent(iface, createRcpt, 'AssetCreated');
  const assetId = created.args[0] as bigint;
  const creationTxId = (created.args[3] as bigint).toString();
  console.log(`  assetId=${assetId} creationTxId=${creationTxId}`);

  await waitFor('L2 to derive Kr for creationTxId', async () => {
    const res = await fetch(`${L2_URL}/keys/${creationTxId}`);
    return res.ok ? true : null;
  });

  const storeRes = await fetch(`${L3_URL}/store`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...l3Headers },
    body: JSON.stringify({
      txId: creationTxId,
      dataType: 'ASSET_METADATA',
      data: { description: 'Exit disposition description', category: 'Test' },
    }),
  });
  assert(storeRes.ok, 'POST /store succeeded');
  const { cid: creationCid } = await storeRes.json() as { cid: string };
  console.log(`  creationCid=${creationCid}`);

  console.log('\n== Carol sets TRANSFER_TO_USER -> Dave, then exits ==');
  await (await (registry.connect(carol) as any).setInactivePolicy(InactivePolicy.TRANSFER_TO_USER, daveAddr)).wait();
  const exitRcpt = await (await (registry.connect(carol) as any).requestExit()).wait();
  const disposed = extractEvent(iface, exitRcpt, 'AssetDispositioned');
  const dispositionTxId = (disposed.args[4] as bigint).toString();
  assert(disposed.args[4] !== ethers.MaxUint256, `disposition got a real txId (${dispositionTxId}), not the burn sentinel`);
  assert((disposed.args[2] as string).toLowerCase() === daveAddr, 'disposition recipient is Dave');

  console.log('\n== Waiting for exit-disposition re-key to complete ==');
  const assetAfterDisposition = await waitFor('asset_txids to repoint at dispositionTxId', async () => {
    const body = await (await fetch(`${L2_URL}/assets/${assetId}`, { headers: { 'Authorization': adminAuth } })).json() as any;
    return body.asset.txId === dispositionTxId ? body.asset : null;
  });

  assert(assetAfterDisposition.owner.toLowerCase() === daveAddr, 'owner is now Dave');
  assert(assetAfterDisposition.metadataCid !== creationCid, 'metadataCid changed after disposition rekey');
  assert(assetAfterDisposition.metadata.description === 'Exit disposition description', 'description survived disposition rekey');

  console.log('\n== Core regression check: Dave unaffected by Carol (former owner) having exited ==');
  const carolTxGone = await waitFor('Carol erasure to complete', async () => {
    const body = await (await fetch(`${L2_URL}/status/${carolAddr}`)).json() as any;
    return body.erasureComplete ? true : null;
  });
  assert(carolTxGone === true, "Carol's erasure completed");

  const oldNowGone = await fetch(`${L3_URL}/retrieve/${creationCid}?txId=${creationTxId}`, { headers: l3Headers });
  assert(oldNowGone.status === 410, "Carol's abandoned creation-txId/creationCid now 410s");

  const newStillGood = await fetch(`${L3_URL}/retrieve/${assetAfterDisposition.metadataCid}?txId=${dispositionTxId}`, { headers: l3Headers });
  assert(newStillGood.status === 200, "Dave's disposition-txId/metadataCid still 200s after Carol's exit");

  console.log('\n== Dave sets BURN and exits himself (no further transfer) ==');
  await (await (registry.connect(dave) as any).setInactivePolicy(InactivePolicy.BURN, ethers.ZeroAddress)).wait();
  await (await (registry.connect(dave) as any).requestExit()).wait();
  await waitFor('Dave erasure to complete', async () => {
    const body = await (await fetch(`${L2_URL}/status/${daveAddr}`)).json() as any;
    return body.erasureComplete ? true : null;
  });

  const finalGone = await fetch(`${L3_URL}/retrieve/${assetAfterDisposition.metadataCid}?txId=${dispositionTxId}`, { headers: l3Headers });
  assert(finalGone.status === 410, "Dave's disposition-txId/metadataCid now 410s after his own (burn) exit");

  const l1Asset = await (registry as any).assets(assetId);
  assert(l1Asset.exists === false, 'asset exists=false on-chain (burned)');

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => {
  console.error('Smoke test crashed:', err);
  process.exit(1);
});
