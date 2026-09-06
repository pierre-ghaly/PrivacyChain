/**
 * Smoke test for the transfer re-key + nonce-based erasure fix.
 *
 * Exercises the exact scenario the fix addresses: a creator transfers an
 * asset, then exits — the new owner's data must survive. Run against a
 * live `npm run dev` stack:
 *
 *   npx tsx scripts/smoke-transfer-rekey.ts
 *
 * Uses Hardhat accounts #4/#5 (untouched by seed.ts, which only uses #0-3)
 * via the node's own eth_sendTransaction signing for its well-known
 * accounts — same trick documented in Frontend/e2e/mock-wallet.ts, no
 * private keys needed.
 */
import { ethers } from 'ethers';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');
const L1_URL = 'http://127.0.0.1:8545';
const L2_URL = process.env.L2_URL ?? 'http://127.0.0.1:3001';
const L3_URL = process.env.L3_URL ?? 'http://127.0.0.1:3002';
const KEYS_DB = path.join(ROOT, 'L2', '.data', 'keys.db');
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

async function main() {
  const provider = new ethers.JsonRpcProvider(L1_URL);
  const admin = await provider.getSigner(0);
  const alice = await provider.getSigner(4);
  const bob = await provider.getSigner(5);
  console.log(`admin=${await admin.getAddress()} alice=${await alice.getAddress()} bob=${await bob.getAddress()}`);
  const adminAuth = await getAuthHeader(admin);

  const { address, abi } = loadDeployment();
  const iface = new ethers.Interface(abi);
  const registry = new ethers.Contract(address, abi, provider);

  const aliceAddr = (await alice.getAddress()).toLowerCase();
  const bobAddr = (await bob.getAddress()).toLowerCase();

  console.log('\n== Setup: register + approve Alice and Bob ==');
  await (await (registry.connect(alice) as any).registerUser()).wait();
  await (await (registry.connect(admin) as any).approveUser(aliceAddr)).wait();
  await (await (registry.connect(bob) as any).registerUser()).wait();
  await (await (registry.connect(admin) as any).approveUser(bobAddr)).wait();

  console.log('\n== Alice creates an asset ==');
  const createRcpt = await (await (registry.connect(alice) as any).createAsset('Smoke Test Asset')).wait();
  const created = extractEvent(iface, createRcpt, 'AssetCreated');
  const assetId = created.args[0] as bigint;
  const txId1 = (created.args[3] as bigint).toString();
  console.log(`  assetId=${assetId} txId1=${txId1}`);

  await waitFor('L2 to derive Kr for txId1', async () => {
    const res = await fetch(`${L2_URL}/keys/${txId1}`);
    return res.ok ? true : null;
  });

  console.log('\n== Store metadata + an image under txId1 ==');
  const imageBytes = Buffer.from('smoke-test-image-bytes');
  const imgRes = await fetch(`${L3_URL}/images`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...l3Headers },
    body: JSON.stringify({ txId: txId1, imageData: imageBytes.toString('base64'), mimeType: 'application/octet-stream' }),
  });
  assert(imgRes.ok, 'POST /images succeeded');
  const { cid: imageCid1 } = await imgRes.json() as { cid: string };

  const storeRes = await fetch(`${L3_URL}/store`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...l3Headers },
    body: JSON.stringify({
      txId: txId1,
      dataType: 'ASSET_METADATA',
      data: { description: 'Smoke test description', category: 'Test', imageCids: [imageCid1] },
    }),
  });
  assert(storeRes.ok, 'POST /store succeeded');
  const { cid: metadataCid1 } = await storeRes.json() as { cid: string };
  console.log(`  metadataCid1=${metadataCid1} imageCid1=${imageCid1}`);

  const assetBefore = await (await fetch(`${L2_URL}/assets/${assetId}`, { headers: { 'Authorization': adminAuth } })).json() as any;
  assert(assetBefore.asset.txId === txId1, `GET /assets resolves txId1 before transfer (got ${assetBefore.asset.txId})`);
  assert(assetBefore.asset.metadataCid === metadataCid1, 'GET /assets resolves metadataCid1 before transfer');

  console.log('\n== Admin approves the asset (required before it can be transferred) ==');
  await (await (registry.connect(admin) as any).approveAsset(assetId)).wait();

  console.log('\n== Alice transfers the asset to Bob ==');
  const transferRcpt = await (await (registry.connect(alice) as any).transferAsset(assetId, bobAddr)).wait();
  const transferred = extractEvent(iface, transferRcpt, 'AssetTransferred');
  const txId2 = (transferred.args[3] as bigint).toString();
  console.log(`  txId2=${txId2}`);

  console.log('\n== Waiting for re-key to complete ==');
  const assetAfterTransfer = await waitFor('asset_txids to repoint at txId2', async () => {
    const body = await (await fetch(`${L2_URL}/assets/${assetId}`, { headers: { 'Authorization': adminAuth } })).json() as any;
    return body.asset.txId === txId2 ? body.asset : null;
  });

  assert(assetAfterTransfer.owner.toLowerCase() === bobAddr, 'owner is now Bob');
  assert(assetAfterTransfer.metadataCid !== metadataCid1, 'metadataCid changed after rekey');
  assert(assetAfterTransfer.metadata.description === 'Smoke test description', 'description survived rekey');
  const newImageCid = assetAfterTransfer.metadata.imageCids?.[0];
  assert(!!newImageCid && newImageCid !== imageCid1, 'image CID changed after rekey');

  const newImgFetch = await fetch(`${L3_URL}/retrieve/${newImageCid}?txId=${txId2}`, { headers: l3Headers });
  const newImgBody = await newImgFetch.json() as any;
  assert(
    Buffer.from(newImgBody.data.data, 'base64').equals(imageBytes),
    'rekeyed image decrypts to the original bytes',
  );

  const oldStillReadable = await fetch(`${L3_URL}/retrieve/${metadataCid1}?txId=${txId1}`, { headers: l3Headers });
  assert(oldStillReadable.status === 200, 'old metadataCid1/txId1 still resolves (nothing proactively revoked)');

  console.log('\n== Alice (former owner) exits ==');
  await (await (registry.connect(alice) as any).requestExit()).wait();
  await waitFor('Alice erasure to complete', async () => {
    const body = await (await fetch(`${L2_URL}/status/${aliceAddr}`)).json() as any;
    return body.erasureComplete ? true : null;
  });

  console.log('\n== Core regression check: Bob unaffected by Alice exiting ==');
  const assetAfterAliceExit = await (await fetch(`${L2_URL}/assets/${assetId}`, { headers: { 'Authorization': adminAuth } })).json() as any;
  assert(
    assetAfterAliceExit.asset.metadata?.description === 'Smoke test description',
    'Bob\'s asset metadata still readable after Alice (former owner) exits',
  );

  const oldNowGone = await fetch(`${L3_URL}/retrieve/${metadataCid1}?txId=${txId1}`, { headers: l3Headers });
  assert(oldNowGone.status === 410, 'old (abandoned) txId1/metadataCid1 now 410s');

  const newStillGood = await fetch(`${L3_URL}/retrieve/${assetAfterTransfer.metadataCid}?txId=${txId2}`, { headers: l3Headers });
  assert(newStillGood.status === 200, 'new txId2/metadataCid still 200s after Alice exits');

  console.log('\n== Bob (current owner) sets BURN and exits ==');
  // Bob still owns this asset, so without an explicit BURN policy his default
  // TRANSFER_TO_SYSTEM would re-key it to systemAddress on exit (correct new
  // behavior — see scripts/smoke-exit-disposition-rekey.ts) rather than erase
  // it. BURN is what actually reaches a terminal, no-new-owner erasure here.
  await (await (registry.connect(bob) as any).setInactivePolicy(2, ethers.ZeroAddress)).wait();
  await (await (registry.connect(bob) as any).requestExit()).wait();
  await waitFor('Bob erasure to complete', async () => {
    const body = await (await fetch(`${L2_URL}/status/${bobAddr}`)).json() as any;
    return body.erasureComplete ? true : null;
  });

  const newNowGone = await fetch(`${L3_URL}/retrieve/${assetAfterTransfer.metadataCid}?txId=${txId2}`, { headers: l3Headers });
  assert(newNowGone.status === 410, 'new txId2/metadataCid now 410s after Bob exits');

  const assetAfterBobExit = await fetch(`${L2_URL}/assets/${assetId}`, { headers: { 'Authorization': adminAuth } });
  assert(assetAfterBobExit.status === 404, 'GET /assets 404s (asset burned) after actual current owner exits with BURN');

  console.log('\n== Verifying true erasure at the SQLite level ==');
  const db = new Database(KEYS_DB, { readonly: true });
  const row1 = db.prepare('SELECT nonce, encryptedKr, destroyed FROM keys WHERE txId = ?').get(txId1) as any;
  assert(row1.destroyed === 1 && row1.nonce === null && row1.encryptedKr === '', `txId1 row has nonce=NULL, encryptedKr='' (got nonce=${row1.nonce}, encryptedKr=${JSON.stringify(row1.encryptedKr)})`);
  const row2 = db.prepare('SELECT nonce, encryptedKr, destroyed FROM keys WHERE txId = ?').get(txId2) as any;
  assert(row2.destroyed === 1 && row2.nonce === null && row2.encryptedKr === '', `txId2 row has nonce=NULL, encryptedKr='' (got nonce=${row2.nonce}, encryptedKr=${JSON.stringify(row2.encryptedKr)})`);
  db.close();

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => {
  console.error('Smoke test crashed:', err);
  process.exit(1);
});
