import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * Deterministic seed script for local development.
 *
 * Reads the current deployment from ../shared/deployments/<network>.json,
 * then uses Hardhat's deterministic test accounts to populate realistic
 * fixtures (registered users, assets, transfers, financial assertions,
 * rejections, and a public/private asset visibility mix).
 *
 * Why a seed script instead of on-disk chain persistence?
 *   • Deterministic: every developer gets the same starting state after
 *     `git pull`, which makes frontend testing reproducible.
 *   • Version-controlled: changes to fixtures are reviewable in PRs.
 *   • Fast: re-running takes seconds, not minutes.
 *   • No extra tooling: works with stock Hardhat.
 *
 * Conventions:
 *   • Account #0 = Admin / deployer / systemAddress (ADMIN_ROLE, creates + approves assets)
 *   • Account #1 = Alice  (assetsPublic + transactionsPublic, TRANSFER_TO_USER → Bob)
 *   • Account #2 = Bob    (private, BURN-on-inactive)
 *   • Account #3 = Carol  (assetsPublic, transactions private, TRANSFER_TO_SYSTEM default)
 *   • Account #4 = Dave   (registered, submits PII, then rejected — compliance demo)
 *   • Accounts #5+ = intentionally unregistered (test "not-registered" UX state)
 *
 * Final asset distribution after all transfers:
 *   Alice:  Downtown Apartment (#0, public), Gold Sovereign Collection (#5 via Carol)
 *   Bob:    Classic Sports Car (#1 via Alice, public), Abstract Oil Painting (#2), Industrial Land Plot (#3)
 *   Carol:  Vintage Rolex Watch (#4)
 *   System: Harbour Warehouse Unit (#6)
 *   Rejected: Disputed Artifact (created and rejected, not distributed)
 */

// UserConfigLib.InactivePolicy enum
const InactivePolicy = {
  TRANSFER_TO_SYSTEM: 0,
  TRANSFER_TO_USER: 1,
  BURN: 2,
} as const;

const L2_URL = process.env.L2_URL ?? "http://127.0.0.1:3001";

// Signs L2's SIWE-lite session challenge with a real Hardhat signer — the
// exact same nonce-then-sign flow the Frontend's getAuthHeader() performs
// with a real wallet (see l2Auth.ts). Seeding through L2's own /l3/store
// gateway, instead of writing to L3 directly, means a broken auth check or
// ownership rule in that gateway shows up as a loud warning on every single
// `npm run dev`, not just whenever the e2e suite or a manual QA pass happens
// to exercise it.
async function getL2AuthHeader(signer: any): Promise<string> {
  const address = await signer.getAddress();
  const nonceRes = await fetch(`${L2_URL}/auth/nonce?address=${address}`);
  if (!nonceRes.ok) {
    throw new Error(`Failed to fetch L2 auth nonce: HTTP ${nonceRes.status}`);
  }
  const { message } = (await nonceRes.json()) as { message: string };
  const signature = await signer.signMessage(message);
  return `${address} ${signature}`;
}

async function seedL3(
  signer: any,
  txId: string,
  dataType: "ASSET_METADATA" | "USER_PII" | "VALUATION" | "SALE_PRICE",
  data: Record<string, unknown>
): Promise<void> {
  try {
    const authHeader = await getL2AuthHeader(signer);
    const res = await fetch(`${L2_URL}/l3/store`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": authHeader },
      body: JSON.stringify({ txId, dataType, data }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.warn(`  [L2] Failed to seed ${dataType} for txId=${txId}: HTTP ${res.status} ${body}`);
    } else {
      const { cid } = (await res.json()) as { cid: string };
      console.log(`  [L2→L3] Stored ${dataType} txId=${txId} → CID=${cid}`);
    }
  } catch (err: any) {
    console.warn(`  [L2] Unreachable while seeding ${dataType} for txId=${txId}: ${err.message}`);
  }
}

// Extracts assetId and txId from the AssetCreated event in a transaction receipt.
function extractAssetCreated(
  registry: any,
  rcpt: any
): { id: bigint; txId: string } {
  const ev = rcpt?.logs
    .map((l: any) => {
      try { return registry.interface.parseLog(l); } catch { return null; }
    })
    .find((p: any) => p && p.name === "AssetCreated");
  return {
    id:   (ev?.args?.[0] ?? 0n) as bigint,
    txId: (ev?.args?.[3] ?? 0n).toString() as string,
  };
}

// Extracts the txId from the UserRegistered event in a registerUser() receipt
// — this is the txId a real registration flow POSTs USER_PII under.
function extractUserRegisteredTxId(registry: any, rcpt: any): string {
  const ev = rcpt?.logs
    .map((l: any) => {
      try { return registry.interface.parseLog(l); } catch { return null; }
    })
    .find((p: any) => p && p.name === "UserRegistered");
  return (ev?.args?.[1] ?? 0n).toString() as string;
}

// Extracts the txId from the FinancialAssertionRequested event — this is the
// txId a valuation/sale-price submission POSTs its (off-chain, never on-chain)
// content under.
function extractFinancialAssertionRequested(registry: any, rcpt: any): string {
  const ev = rcpt?.logs
    .map((l: any) => {
      try { return registry.interface.parseLog(l); } catch { return null; }
    })
    .find((p: any) => p && p.name === "FinancialAssertionRequested");
  return (ev?.args?.[3] ?? 0n).toString() as string;
}

async function main() {
  const networkName = (await ethers.provider.getNetwork()).name || "localhost";
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const resolvedNet = chainId === 31337 ? "localhost" : networkName;

  const deploymentFile = path.resolve(
    __dirname, "..", "..", "shared", "deployments", `${resolvedNet}.json`
  );
  if (!fs.existsSync(deploymentFile)) {
    throw new Error(`No deployment file at ${deploymentFile}. Run deploy first.`);
  }

  const deployment = JSON.parse(fs.readFileSync(deploymentFile, "utf8"));
  const contractAddress = deployment.contracts.AssetRegistry.address;

  const [admin, alice, bob, carol, dave] = await ethers.getSigners();
  const registry = await ethers.getContractAt("AssetRegistry", contractAddress) as any;

  console.log("Seeding AssetRegistry at", contractAddress);
  console.log("  admin  (#0) =", admin.address, " ← systemAddress, has ADMIN_ROLE");
  console.log("  alice  (#1) =", alice.address);
  console.log("  bob    (#2) =", bob.address);
  console.log("  carol  (#3) =", carol.address);
  console.log("  dave   (#4) =", dave.address, " ← registered then rejected (compliance demo)");
  console.log("");

  // -------------------------------------------------------------------------
  // Users
  // -------------------------------------------------------------------------
  console.log("Registering and approving users...");

  const aliceRegRcpt = await (await registry.connect(alice).registerUser()).wait();
  await (await registry.connect(admin).approveUser(alice.address)).wait();

  const bobRegRcpt = await (await registry.connect(bob).registerUser()).wait();
  await (await registry.connect(admin).approveUser(bob.address)).wait();

  const carolRegRcpt = await (await registry.connect(carol).registerUser()).wait();
  await (await registry.connect(admin).approveUser(carol.address)).wait();

  const userPiiFixtures: Array<{ signer: any; txId: string; data: Record<string, unknown> }> = [
    {
      signer: alice,
      txId: extractUserRegisteredTxId(registry, aliceRegRcpt),
      data: { realName: "Alice Moreau", email: "alice.moreau@example.com", address: "14 Rue de Rivoli, Paris" },
    },
    {
      signer: bob,
      txId: extractUserRegisteredTxId(registry, bobRegRcpt),
      data: { realName: "Bob Keller", email: "bob.keller@example.com" },
    },
    {
      signer: carol,
      txId: extractUserRegisteredTxId(registry, carolRegRcpt),
      data: { realName: "Carol Dubois", email: "carol.dubois@example.com", address: "9 Quai de la Joliette, Marseille" },
    },
  ];

  // -------------------------------------------------------------------------
  // Dave: registers, submits PII, then gets rejected outright (e.g. a failed
  // compliance check) — demonstrates the reject/decline path and its
  // key-destruction consequence. Posting PII before rejecting is deliberate:
  // it's the scenario the feature exists for (data submitted before admin
  // ever reviewed it must not linger decryptable under a rejected account).
  // -------------------------------------------------------------------------
  console.log("Registering and rejecting dave (compliance demo)...");
  const daveRegRcpt = await (await registry.connect(dave).registerUser()).wait();
  const daveRegTxId = extractUserRegisteredTxId(registry, daveRegRcpt);
  await seedL3(dave, daveRegTxId, "USER_PII", { realName: "Dave Whitfield", email: "dave.whitfield@example.com" });
  await (await registry.connect(admin).rejectUser(dave.address)).wait();

  // -------------------------------------------------------------------------
  // Per-user configuration
  // Must run after approval (onlyRegisteredAndActive).
  // Alice's TRANSFER_TO_USER policy references bob — bob must be active first.
  // -------------------------------------------------------------------------
  console.log("Configuring user policies...");

  // Alice: fully public + TRANSFER_TO_USER (to Bob) on inactivity
  await (await registry.connect(alice).setVisibility(true, true)).wait();
  await (await registry.connect(alice).setInactivePolicy(InactivePolicy.TRANSFER_TO_USER, bob.address)).wait();

  // Bob: private, BURN-on-inactive
  await (await registry.connect(bob).setVisibility(false, false)).wait();
  await (await registry.connect(bob).setInactivePolicy(InactivePolicy.BURN, ethers.ZeroAddress)).wait();

  // Carol: assets public, transactions private, default TRANSFER_TO_SYSTEM
  await (await registry.connect(carol).setVisibility(true, false)).wait();

  // -------------------------------------------------------------------------
  // Assets — created by admin (systemAddress), approved, then distributed
  // -------------------------------------------------------------------------
  console.log("Creating 7 assets...");

  type AssetFixture = { name: string; metadata: Record<string, unknown> };
  const assetFixtures: AssetFixture[] = [
    // #0 — will go to Alice (stays with Alice)
    {
      name: "Downtown Apartment",
      metadata: {
        description: "2-bedroom apartment in the city centre, recently renovated with period features retained.",
        category: "Real Estate",
        metadata: {
          location: "12 Rue de Rivoli, Paris",
          size: "75 sqm",
          yearBuilt: "1930",
          bedrooms: "2",
          condition: "Excellent",
        },
      },
    },
    // #1 — admin → Alice → Bob
    {
      name: "Classic Sports Car",
      metadata: {
        description: "1967 Ford Mustang Fastback, fully restored to factory spec, matching numbers throughout.",
        category: "Vehicle",
        metadata: {
          make: "Ford",
          model: "Mustang Fastback",
          year: "1967",
          mileage: "52000",
          color: "Candy Apple Red",
          vin: "7F02S123456",
        },
      },
    },
    // #2 — will go to Bob (stays with Bob)
    {
      name: "Abstract Oil Painting",
      metadata: {
        description: "Large-format abstract work on canvas by emerging artist Marie Laurent.",
        category: "Artwork",
        metadata: {
          artist: "Marie Laurent",
          medium: "Oil on canvas",
          dimensions: "120x90 cm",
          year: "2021",
          condition: "Mint",
        },
      },
    },
    // #3 — will go to Bob (stays with Bob)
    {
      name: "Industrial Land Plot",
      metadata: {
        description: "Zoned industrial land parcel with full utility connections in northern Lyon.",
        category: "Real Estate",
        metadata: {
          location: "Zone Industrielle Nord, Lyon",
          size: "2400 sqm",
          yearRegistered: "2005",
          zoning: "Industrial",
        },
      },
    },
    // #4 — will go to Carol (stays with Carol)
    {
      name: "Vintage Rolex Watch",
      metadata: {
        description: "1972 Rolex Submariner ref. 1680, original gloss dial, complete service history documented.",
        category: "Collectible",
        metadata: {
          brand: "Rolex",
          model: "Submariner 1680",
          year: "1972",
          serialNumber: "3248XXX",
          condition: "Very Good",
        },
      },
    },
    // #5 — admin → Carol → Alice
    {
      name: "Gold Sovereign Collection",
      metadata: {
        description: "50 British Gold Sovereigns from 1905–1968, individually graded AU-MS by NGC.",
        category: "Precious Metals",
        metadata: {
          quantity: "50 coins",
          metalPurity: "91.67% gold",
          totalWeightOz: "11.75 troy oz",
          gradingCertifier: "NGC",
          mintYearRange: "1905–1968",
        },
      },
    },
    // #6 — stays with system (admin/systemAddress)
    {
      name: "Harbour Warehouse Unit",
      metadata: {
        description: "Commercial storage unit in bonded warehouse zone, Marseille port authority managed.",
        category: "Real Estate",
        metadata: {
          location: "Quai de la Joliette, Marseille",
          size: "600 sqm",
          yearBuilt: "1985",
          zoning: "Commercial/Storage",
        },
      },
    },
  ];

  const assetIds: bigint[] = [];
  const assetTxIds: string[] = [];

  for (const fixture of assetFixtures) {
    const tx = await registry.connect(admin).createAsset(fixture.name);
    const rcpt = await tx.wait();
    const { id, txId } = extractAssetCreated(registry, rcpt);
    assetIds.push(id);
    assetTxIds.push(txId);
  }
  console.log("  Created asset IDs:", assetIds.map(String).join(", "));

  // -------------------------------------------------------------------------
  // Approve all assets
  // -------------------------------------------------------------------------
  console.log("Approving all assets...");
  for (const id of assetIds) {
    await (await registry.connect(admin).approveAsset(id)).wait();
  }

  // -------------------------------------------------------------------------
  // Distribute assets from admin to users
  // admin → Alice: #0 (Downtown Apartment), #1 (Classic Sports Car)
  // admin → Bob:   #2 (Abstract Oil Painting), #3 (Industrial Land Plot)
  // admin → Carol: #4 (Vintage Rolex Watch), #5 (Gold Sovereign Collection)
  // admin keeps:   #6 (Harbour Warehouse Unit — systemAddress)
  // -------------------------------------------------------------------------
  console.log("Distributing assets admin → users...");
  await (await registry.connect(admin).transferAsset(assetIds[0], alice.address)).wait();
  await (await registry.connect(admin).transferAsset(assetIds[1], alice.address)).wait();
  await (await registry.connect(admin).transferAsset(assetIds[2], bob.address)).wait();
  await (await registry.connect(admin).transferAsset(assetIds[3], bob.address)).wait();
  await (await registry.connect(admin).transferAsset(assetIds[4], carol.address)).wait();
  await (await registry.connect(admin).transferAsset(assetIds[5], carol.address)).wait();

  // -------------------------------------------------------------------------
  // User-to-user transfers (creates multi-hop ownership history)
  //   Alice  →  Bob:   Classic Sports Car (#1)
  //   Carol  →  Alice: Gold Sovereign Collection (#5)
  // -------------------------------------------------------------------------
  console.log("Executing user-to-user transfers...");
  await (await registry.connect(alice).transferAsset(assetIds[1], bob.address)).wait();
  await (await registry.connect(carol).transferAsset(assetIds[5], alice.address)).wait();

  // Final ownership:
  //   Alice:  #0 Downtown Apartment, #5 Gold Sovereign Collection
  //   Bob:    #1 Classic Sports Car, #2 Abstract Oil Painting, #3 Industrial Land Plot
  //   Carol:  #4 Vintage Rolex Watch
  //   System: #6 Harbour Warehouse Unit

  // -------------------------------------------------------------------------
  // Explorer visibility — a mix of public/private assets for Explorer demos.
  // Owner-only, so must run after the transfers above put each asset with
  // its final owner. Everything else stays at its private-by-default value.
  // -------------------------------------------------------------------------
  console.log("Setting a public/private asset visibility mix...");
  await (await registry.connect(alice).setAssetVisibility(assetIds[0], true)).wait(); // Downtown Apartment -> public
  await (await registry.connect(bob).setAssetVisibility(assetIds[1], true)).wait();   // Classic Sports Car -> public

  // -------------------------------------------------------------------------
  // A rejected asset — demonstrates the reject/decline path for a pending
  // asset, same key-destruction-on-reject principle as dave's rejection above.
  // -------------------------------------------------------------------------
  console.log("Creating and rejecting an asset (compliance demo)...");
  const rejectedAssetRcpt = await (await registry.connect(admin).createAsset("Disputed Artifact")).wait();
  const { id: rejectedAssetId, txId: rejectedAssetTxId } = extractAssetCreated(registry, rejectedAssetRcpt);
  await seedL3(admin, rejectedAssetTxId, "ASSET_METADATA", {
    description: "Provenance could not be verified — held for compliance review.",
    category: "Disputed",
  });
  await (await registry.connect(admin).rejectAsset(rejectedAssetId)).wait();

  // -------------------------------------------------------------------------
  // Financial assertions (valuations + one sale-price proposal) — off-chain,
  // admin-approved. Mints a txId on-chain (requestFinancialAssertion), posts
  // the real value through L2's /l3/store like any other off-chain write,
  // then admin decides on-chain (decideFinancialAssertion) — no price/value
  // ever touches L1. Admin certifies most valuations; current owners can
  // also self-certify their own assets. A sale-price proposal (counterparty
  // set) additionally requires both parties to call confirmFinancialAssertion
  // on-chain before admin's approval succeeds — see the sale-price block below.
  // -------------------------------------------------------------------------
  console.log("Requesting and approving financial assertions (valuations)...");

  type AssertionFixture = { signer: any; assetIndex: number; data: Record<string, unknown> };
  const assertionFixtures: AssertionFixture[] = [
    // Downtown Apartment (#0): two appraisals showing value appreciation
    { signer: admin, assetIndex: 0, data: { value: 450000, currencyCode: "USD", entity: "Admin-certified appraisal" } },
    { signer: admin, assetIndex: 0, data: { value: 480000, currencyCode: "USD", entity: "Admin-certified appraisal (follow-up)" } },
    // Industrial Land Plot (#3): single appraisal
    { signer: admin, assetIndex: 3, data: { value: 3800000, currencyCode: "EUR", entity: "Admin-certified appraisal" } },
    // Abstract Oil Painting (#2): gallery valuation
    { signer: admin, assetIndex: 2, data: { value: 12000, currencyCode: "EUR", entity: "Gallery valuation" } },
    // Gold Sovereign Collection (#5): Alice (current owner) self-certifies spot price
    { signer: alice, assetIndex: 5, data: { value: 8500, currencyCode: "GBP", entity: "Self-certified spot price" } },
    // Classic Sports Car (#1): Bob (current owner) self-certifies auction estimate
    { signer: bob, assetIndex: 1, data: { value: 85000, currencyCode: "USD", entity: "Auction estimate" } },
  ];

  for (const fixture of assertionFixtures) {
    const assetId = assetIds[fixture.assetIndex];
    const rcpt = await (await registry.connect(fixture.signer).requestFinancialAssertion(assetId, ethers.ZeroAddress)).wait();
    const txId = extractFinancialAssertionRequested(registry, rcpt);
    await seedL3(fixture.signer, txId, "VALUATION", fixture.data);
    await (await registry.connect(admin).decideFinancialAssertion(txId, true)).wait();
  }

  // One real sale-price proposal, demonstrating the both-parties-confirm
  // gate: admin's decideFinancialAssertion(true) reverts on-chain unless
  // both the seller (Bob) and buyer (Carol) have called
  // confirmFinancialAssertion first — see AssetRegistry.sol.
  console.log("Requesting, confirming (both sides), and approving a sale-price proposal...");
  {
    const assetId = assetIds[1]; // Classic Sports Car, owned by Bob
    const rcpt = await (
      await registry.connect(bob).requestFinancialAssertion(assetId, carol.address)
    ).wait();
    const txId = extractFinancialAssertionRequested(registry, rcpt);
    await seedL3(bob, txId, "SALE_PRICE", { value: 92000, currencyCode: "USD" });
    await (await registry.connect(bob).confirmFinancialAssertion(txId)).wait();
    await (await registry.connect(carol).confirmFinancialAssertion(txId)).wait();
    await (await registry.connect(admin).decideFinancialAssertion(txId, true)).wait();
  }

  // -------------------------------------------------------------------------
  // L3 encrypted metadata
  // Posts ASSET_METADATA through L2's /l3/store gateway for each asset,
  // using the creation txId — admin created every asset, and still owns
  // that txId's key in L2 regardless of who owns the asset now (transfers
  // rekey a *new* txId to the new owner; they don't touch the original
  // creation txId's ownership record). L2 must have derived Kr for these
  // txIds before L3 can encrypt. Safe to skip if L2/L3 is not running —
  // seed continues with a warning.
  // -------------------------------------------------------------------------
  console.log("Seeding L3 encrypted metadata via L2 (skipped if L2/L3 is offline)...");
  for (let i = 0; i < assetFixtures.length; i++) {
    await seedL3(admin, assetTxIds[i], "ASSET_METADATA", assetFixtures[i].metadata);
  }

  // -------------------------------------------------------------------------
  // L3 encrypted PII
  // Posts USER_PII through L2's /l3/store gateway for each registered user,
  // signed by that user's own registration txId, so a seeded account's
  // Settings page shows real PII instead of "No PII on record" — matching
  // what a hand-registered account would show.
  // -------------------------------------------------------------------------
  console.log("Seeding L3 encrypted PII via L2 (skipped if L2/L3 is offline)...");
  for (const fixture of userPiiFixtures) {
    await seedL3(fixture.signer, fixture.txId, "USER_PII", fixture.data);
  }

  console.log("");
  console.log("Seed complete. Summary:");
  console.log("  • 3 registered+active users: alice (#1), bob (#2), carol (#3)");
  console.log("  • dave (#4): registered then rejected — compliance demo, key destroyed");
  console.log("  • 7 assets created and approved, 1 asset created and rejected:");
  console.log("    Alice  → Downtown Apartment (#0, public), Gold Sovereign Collection (#5 from Carol)");
  console.log("    Bob    → Classic Sports Car (#1 from Alice, public), Abstract Oil Painting (#2), Industrial Land Plot (#3)");
  console.log("    Carol  → Vintage Rolex Watch (#4)");
  console.log("    System → Harbour Warehouse Unit (#6)");
  console.log("    Rejected → Disputed Artifact — compliance demo, key destroyed");
  console.log("  • Financial assertions (off-chain, admin-approved): Downtown Apartment (2×USD),");
  console.log("    Industrial Land Plot (EUR), Abstract Oil Painting (EUR), Gold Sovereign Collection (GBP),");
  console.log("    Classic Sports Car valuation (USD) — no price/value ever touched L1");
  console.log("  • One sale-price proposal: Classic Sports Car, Bob → Carol (USD) — both parties");
  console.log("    confirmed on-chain (confirmFinancialAssertion) before admin approved");
  console.log("  • Explorer access mode still REGISTERED_ONLY (platform default) — toggle via setExplorerAccessMode to demo public browsing");
  console.log("  • Accounts #5+ left unregistered (for testing unregistered UX)");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
