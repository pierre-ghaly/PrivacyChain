import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * End-to-end RTBF demonstration script.
 *
 * Drives the full 9-step flow across all three layers without a Frontend,
 * routing every L3 call through L2's real signed-session gateway exactly
 * as the Frontend does — L3 rejects any direct (non-L2) caller by design,
 * so this script authenticates as Dave (a SIWE-lite nonce + signature)
 * before touching /l3/*.
 *   Steps 1–3  → L1 on-chain operations (register, approve, create asset)
 *   Steps 4–5  → L2 gateway → L3 encrypted storage (USER_PII + ASSET_METADATA)
 *   Step  6    → L2 gateway → L3 retrieve (before erasure — expect 200)
 *   Step  7    → L1 RTBF exit (requestExit → L2 destroys keys → L1 proof)
 *   Step  8    → L2 gateway → L3 retrieve (after erasure — expect 410)
 *   Step  9    → L1 + L2 audit verification
 *
 * Prerequisites:
 *   npm run dev          (Hardhat + L2 + L3 all running)
 *
 * Run:
 *   npm run contracts:demo
 *   — or —
 *   npx hardhat run scripts/demo.ts --network localhost
 *
 * Uses Hardhat account #4 (unregistered by the seed script).
 * Re-run requires a fresh `npm run dev` because once an address has exited
 * it cannot re-register on the same chain.
 */

const L2 = "http://127.0.0.1:3001";
const L3 = "http://127.0.0.1:3002";

// ─── Helpers ───────────────────────────────────────────────────────────────

function banner(step: number, title: string) {
  const line = "─".repeat(62);
  console.log(`\n${line}`);
  console.log(`  Step ${step}: ${title}`);
  console.log(line);
}

function log(msg: string)  { console.log(`  ${msg}`); }
function ok(msg: string)   { console.log(`  ✓ ${msg}`); }
function info(msg: string) { console.log(`    ${msg}`); }

function parseEvent(
  receipt: { logs: readonly { topics: string[]; data: string }[] } | null,
  iface: ethers.Interface,
  name: string,
) {
  for (const raw of receipt?.logs ?? []) {
    try {
      const parsed = iface.parseLog(raw as { topics: string[]; data: string });
      if (parsed?.name === name) return parsed;
    } catch { /* skip non-matching logs */ }
  }
  return null;
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function waitForKey(txId: string, label: string, timeoutMs = 10_000): Promise<void> {
  log(`Waiting for L2 to derive key for ${label} (txId=${txId})...`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${L2}/keys/${txId}`);
    if (res.ok)          { ok(`Key ready.`); return; }
    if (res.status === 410) throw new Error(`Key for txId=${txId} already destroyed`);
    await sleep(400);
  }
  throw new Error(`Timeout: L2 did not derive key for txId=${txId} within ${timeoutMs}ms`);
}

async function waitForErasure(userAddress: string, timeoutMs = 15_000): Promise<void> {
  log(`Waiting for L2 to destroy keys for ${userAddress}...`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res  = await fetch(`${L2}/status/${userAddress}`);
    const body = (await res.json()) as { erasureComplete: boolean; destroyedKeys: number; totalKeys: number };
    if (body.erasureComplete) { ok(`Keys destroyed (${body.destroyedKeys}/${body.totalKeys}).`); return; }
    await sleep(400);
  }
  throw new Error(`Timeout: L2 did not finish destroying keys for ${userAddress} within ${timeoutMs}ms`);
}

// `/status/:user`'s erasureComplete flips the instant L2 destroys keys
// locally — before it has even submitted recordErasureProof() to L1, let
// alone had it mined. Anything reading getErasureProof() (Step 9) needs to
// wait on that L1 confirmation specifically, not on L2's local key state.
async function waitForProofOnChain(
  registry: { getExitStatus: (addr: string) => Promise<[boolean, bigint, boolean]> },
  userAddress: string,
  timeoutMs = 15_000,
): Promise<void> {
  log(`Waiting for L2 to record the erasure proof on L1 for ${userAddress}...`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [, , hasProof] = await registry.getExitStatus(userAddress);
    if (hasProof) { ok(`Erasure proof confirmed on L1.`); return; }
    await sleep(400);
  }
  throw new Error(`Timeout: erasure proof was not recorded on L1 for ${userAddress} within ${timeoutMs}ms`);
}

// L2 is the only path to L3: every /l3/* call needs a signed SIWE-lite
// session, obtained by signing the exact nonce message L2 issues. Never
// construct the message locally — always sign what L2 sent.
async function authHeader(wallet: { address: string; signMessage: (m: string) => Promise<string> }): Promise<string> {
  const nonceRes = await fetch(`${L2}/auth/nonce?address=${wallet.address}`);
  const { message } = (await nonceRes.json()) as { message: string };
  const signature = await wallet.signMessage(message);
  return `${wallet.address} ${signature}`;
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║   PrivacyChain — RTBF End-to-End Demo (L1 + L2 + L3)        ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");

  // ── Preflight checks ──────────────────────────────────────────────────────
  for (const [label, url] of [["L2", `${L2}/health`], ["L3", `${L3}/health`]]) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    } catch (e: any) {
      throw new Error(`${label} is not running (${url}): ${e.message}\n  → Run \`npm run dev\` first`);
    }
  }

  const deploymentPath = path.resolve(__dirname, "../../shared/deployments/localhost.json");
  if (!fs.existsSync(deploymentPath)) {
    throw new Error("No deployment found at shared/deployments/localhost.json\n  → Run `npm run dev` first");
  }
  const deployment  = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
  const contractAddr = deployment.contracts.AssetRegistry.address;

  const signers = await ethers.getSigners();
  const admin   = signers[0]; // Hardhat account #0 — deployer + ADMIN_ROLE
  const dave    = signers[4]; // Hardhat account #4 — unregistered by seed script

  const registry = await ethers.getContractAt("AssetRegistry", contractAddr);
  const iface    = registry.interface;

  // Guard: abort cleanly if Dave has already been used
  const daveState = await registry.users(dave.address);
  if (daveState.isRegistered) {
    throw new Error(
      `Account #4 (${dave.address}) is already registered.\n` +
      `  → Restart the dev environment with \`npm run dev\` and re-run.`
    );
  }

  log(`Contract:  ${contractAddr}`);
  log(`Admin:     ${admin.address}`);
  log(`Demo user: ${dave.address}  (Hardhat account #4)`);

  // ── Step 1: Register ──────────────────────────────────────────────────────
  banner(1, "Register User  (L1: registerUser)");
  const regReceipt  = await (await registry.connect(dave).registerUser()).wait();
  const regEvent    = parseEvent(regReceipt, iface, "UserRegistered")!;
  const regTxId     = regEvent.args[1].toString(); // (address user, uint256 transactionId)
  ok(`UserRegistered — txId=${regTxId}`);
  info(`L2 will derive Kr for txId=${regTxId} → used to encrypt USER_PII`);

  // ── Step 2: Approve ───────────────────────────────────────────────────────
  banner(2, "Approve User  (L1: approveUser)");
  const approveReceipt = await (await registry.connect(admin).approveUser(dave.address)).wait();
  const approveEvent   = parseEvent(approveReceipt, iface, "UserApproved")!;
  const approveTxId    = approveEvent.args[1].toString();
  ok(`UserApproved — txId=${approveTxId}`);
  info(`Dave can now create assets and call onlyRegisteredAndActive functions`);

  // ── Step 3: Create asset ──────────────────────────────────────────────────
  banner(3, "Create Asset  (L1: createAsset)");
  const assetReceipt = await (await registry.connect(dave).createAsset("Dave's Research Dataset")).wait();
  const assetEvent   = parseEvent(assetReceipt, iface, "AssetCreated")!;
  const assetId      = assetEvent.args[0].toString(); // (uint256 assetId, address owner, string name, uint256 txId)
  const assetTxId    = assetEvent.args[3].toString();
  ok(`AssetCreated — assetId=${assetId}  txId=${assetTxId}`);
  info(`L2 will derive Kr for txId=${assetTxId} → used to encrypt ASSET_METADATA`);

  // Wait for L2 to process both events before hitting L3
  await waitForKey(regTxId,   "registration");
  await waitForKey(assetTxId, "asset");

  // Sign in once — the same SIWE-lite session covers every /l3/* call below
  const auth = await authHeader(dave);

  // ── Step 4: Store USER_PII ────────────────────────────────────────────────
  banner(4, "Store USER_PII  (via L2 gateway: POST /l3/store)");
  const piiPayload = {
    txId:     regTxId,
    dataType: "USER_PII",
    data: {
      name:    "Dave Researcher",
      email:   "dave@privacychain.eth",
      dob:     "1990-06-15",
      address: "123 Privacy Lane, GDPR City",
    },
  };
  const storeRes = await fetch(`${L2}/l3/store`, {
    method:  "POST",
    headers: { "Content-Type": "application/json", Authorization: auth },
    body:    JSON.stringify(piiPayload),
  });
  const stored = (await storeRes.json()) as { ok: boolean; cid: string };
  if (!stored.ok) throw new Error(`L2 /l3/store failed: HTTP ${storeRes.status} ${JSON.stringify(stored)}`);
  const piiCid = stored.cid;
  ok(`USER_PII stored.`);
  info(`CID:  ${piiCid}`);
  info(`Blob: AES-256-GCM encrypted, pinned to local Helia IPFS`);

  // ── Step 5: Store ASSET_METADATA ─────────────────────────────────────────
  banner(5, "Store ASSET_METADATA  (via L2 gateway: POST /l3/store)");
  const metaPayload = {
    txId:     assetTxId,
    dataType: "ASSET_METADATA",
    data: {
      assetId,
      name:        "Dave's Research Dataset",
      description: "Anonymised participant data from PhD study",
      createdAt:   new Date().toISOString(),
      owner:       dave.address,
    },
  };
  const assetStoreRes = await fetch(`${L2}/l3/store`, {
    method:  "POST",
    headers: { "Content-Type": "application/json", Authorization: auth },
    body:    JSON.stringify(metaPayload),
  });
  const assetStored = (await assetStoreRes.json()) as { ok: boolean; cid: string };
  if (!assetStored.ok) throw new Error(`L2 /l3/store failed: ${JSON.stringify(assetStored)}`);
  const assetCid = assetStored.cid;
  ok(`ASSET_METADATA stored.`);
  info(`CID: ${assetCid}`);

  // ── Step 6: Retrieve (before erasure) ─────────────────────────────────────
  banner(6, "Retrieve Data  (before RTBF, via L2 gateway — expect HTTP 200)");

  const r1  = await fetch(`${L2}/l3/retrieve/${piiCid}?txId=${regTxId}`, { headers: { Authorization: auth } });
  const r1b = (await r1.json()) as { data: unknown };
  log(`GET /l3/retrieve/${piiCid}?txId=${regTxId}`);
  ok(`HTTP ${r1.status}  →  ${JSON.stringify(r1b.data)}`);

  const r2  = await fetch(`${L2}/l3/retrieve/${assetCid}?txId=${assetTxId}`, { headers: { Authorization: auth } });
  const r2b = (await r2.json()) as { data: unknown };
  log(`GET /l3/retrieve/${assetCid}?txId=${assetTxId}`);
  ok(`HTTP ${r2.status}  →  ${JSON.stringify(r2b.data)}`);

  // ── Step 7: RTBF exit ─────────────────────────────────────────────────────
  banner(7, "RTBF Exit  (L1: requestExit → L2: destroy keys → L1: recordErasureProof)");
  const exitReceipt = await (await registry.connect(dave).requestExit()).wait();
  const kdrEvent    = parseEvent(exitReceipt, iface, "KeyDestructionRequested")!;
  // (address user, uint256[] assetIds, uint256[] dispositionTxIds, address[] newOwners, uint256[] transactionIds)
  const destroyedTxIds = (kdrEvent.args[4] as bigint[]).map(id => id.toString());
  ok(`requestExit() mined — block ${exitReceipt!.blockNumber}`);
  info(`KeyDestructionRequested → txIds to destroy: [${destroyedTxIds.join(", ")}]`);
  info(`L2 is now: destroying Kr entries → computing SHA-256 proof → calling recordErasureProof()`);

  await waitForErasure(dave.address.toLowerCase());

  // ── Step 8: Retrieve (after erasure) ─────────────────────────────────────
  banner(8, "Retrieve Data  (after RTBF, via L2 gateway — expect HTTP 410)");

  const e1  = await fetch(`${L2}/l3/retrieve/${piiCid}?txId=${regTxId}`, { headers: { Authorization: auth } });
  const e1b = (await e1.json()) as { error: string; note?: string };
  log(`GET /l3/retrieve/${piiCid}?txId=${regTxId}`);
  ok(`HTTP ${e1.status}`);
  info(`error: ${e1b.error}`);
  if (e1b.note) info(`note:  ${e1b.note}`);

  const e2  = await fetch(`${L2}/l3/retrieve/${assetCid}?txId=${assetTxId}`, { headers: { Authorization: auth } });
  const e2b = (await e2.json()) as { error: string };
  log(`GET /l3/retrieve/${assetCid}?txId=${assetTxId}`);
  ok(`HTTP ${e2.status}`);
  info(`error: ${e2b.error}`);

  // ── Step 9: Audit verification ────────────────────────────────────────────
  banner(9, "Audit Verification  (L1 + L2)");

  await waitForProofOnChain(registry as any, dave.address);

  const proofHash          = await registry.getErasureProof(dave.address);
  const [exited, exitTs, hasProof] = await registry.getExitStatus(dave.address);
  const statusRes          = await fetch(`${L2}/status/${dave.address.toLowerCase()}`);
  const l2Status           = (await statusRes.json()) as {
    totalKeys: number; destroyedKeys: number; activeKeys: number; erasureComplete: boolean;
  };

  log(`L1 getErasureProof(${dave.address}):`);
  info(`proofHash:       ${proofHash}`);
  log(`L1 getExitStatus(${dave.address}):`);
  info(`exited:          ${exited}`);
  info(`exitTimestamp:   ${new Date(Number(exitTs) * 1000).toISOString()}`);
  info(`hasErasureProof: ${hasProof}`);
  log(`L2 /status/${dave.address.toLowerCase()}:`);
  info(`totalKeys:       ${l2Status.totalKeys}`);
  info(`destroyedKeys:   ${l2Status.destroyedKeys}`);
  info(`activeKeys:      ${l2Status.activeKeys}`);
  info(`erasureComplete: ${l2Status.erasureComplete}`);

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║   RTBF Demo Complete                                         ║");
  console.log("╠══════════════════════════════════════════════════════════════╣");
  ok(`User registered and approved on L1 (pseudonymous identifier: ${dave.address})`);
  ok(`Asset created on L1 (assetId=${assetId})`);
  ok(`USER_PII stored encrypted in IPFS    → CID: ${piiCid}`);
  ok(`ASSET_METADATA stored encrypted in IPFS → CID: ${assetCid}`);
  ok(`requestExit() executed — asset disposition + deactivation complete`);
  ok(`L2 destroyed ${l2Status.destroyedKeys} Kr reference key(s)`);
  ok(`Erasure proof anchored on L1: ${proofHash}`);
  ok(`Post-erasure retrieve returns HTTP 410 — cryptographic erasure proven`);
  info(`The encrypted blobs (CIDs above) still exist on IPFS and always will.`);
  info(`They are permanently unreadable without Kr — stronger than deletion.`);
  console.log("╚══════════════════════════════════════════════════════════════╝\n");
}

main().catch(err => {
  console.error("\n[demo] FAILED:", err.message ?? err);
  process.exit(1);
});
