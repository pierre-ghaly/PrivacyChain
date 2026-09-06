import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * Deterministic seed script for local development.
 *
 * Reads the current deployment from ../shared/deployments/<network>.json,
 * then uses Hardhat's deterministic test accounts to populate realistic
 * fixtures (registered users, assets, transfers, valuations).
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
 *   • Accounts #4+ = intentionally unregistered (test "not-registered" UX state)
 *
 * Final asset distribution after all transfers:
 *   Alice:  Downtown Apartment (#0), Gold Sovereign Collection (#5 via Carol)
 *   Bob:    Classic Sports Car (#1 via Alice), Abstract Oil Painting (#2), Industrial Land Plot (#3)
 *   Carol:  Vintage Rolex Watch (#4)
 *   System: Harbour Warehouse Unit (#6)
 */

// UserConfigLib.InactivePolicy enum
const InactivePolicy = {
  TRANSFER_TO_SYSTEM: 0,
  TRANSFER_TO_USER: 1,
  BURN: 2,
} as const;

// ISO 4217 currency codes as bytes3 hex literals
const USD = "0x555344";
const EUR = "0x455552";
const GBP = "0x474250";

const L3_URL = process.env.L3_URL ?? "http://127.0.0.1:3002";
// This script calls L3 directly (bypassing L2's /l3/* proxy) to seed fixture
// data before any Frontend session exists — L3 requires this on every route
// but /health.
const L3_INTERNAL_KEY = process.env.L3_INTERNAL_KEY ?? "dev-only-l2-l3-shared-secret-change-in-production";

async function seedL3Metadata(
  txId: string,
  metadata: Record<string, unknown>
): Promise<void> {
  try {
    const res = await fetch(`${L3_URL}/store`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Internal-Key": L3_INTERNAL_KEY },
      body: JSON.stringify({ txId, dataType: "ASSET_METADATA", data: metadata }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.warn(`  [L3] Failed to seed metadata for txId=${txId}: ${body}`);
    } else {
      const { cid } = (await res.json()) as { cid: string };
      console.log(`  [L3] Stored ASSET_METADATA txId=${txId} → CID=${cid}`);
    }
  } catch (err: any) {
    console.warn(`  [L3] L3 unreachable for txId=${txId}: ${err.message}`);
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

  const [admin, alice, bob, carol] = await ethers.getSigners();
  const registry = await ethers.getContractAt("AssetRegistry", contractAddress) as any;

  console.log("Seeding AssetRegistry at", contractAddress);
  console.log("  admin  (#0) =", admin.address, " ← systemAddress, has ADMIN_ROLE");
  console.log("  alice  (#1) =", alice.address);
  console.log("  bob    (#2) =", bob.address);
  console.log("  carol  (#3) =", carol.address);
  console.log("");

  // -------------------------------------------------------------------------
  // Users
  // -------------------------------------------------------------------------
  console.log("Registering and approving users...");

  await (await registry.connect(alice).registerUser()).wait();
  await (await registry.connect(admin).approveUser(alice.address)).wait();

  await (await registry.connect(bob).registerUser()).wait();
  await (await registry.connect(admin).approveUser(bob.address)).wait();

  await (await registry.connect(carol).registerUser()).wait();
  await (await registry.connect(admin).approveUser(carol.address)).wait();

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
  // On-chain valuations
  // Stored as smallest currency unit (cents/pence). Admin certifies most;
  // current owners can also certify their own assets.
  // -------------------------------------------------------------------------
  console.log("Adding on-chain valuations...");

  // Downtown Apartment (#0): two appraisals showing value appreciation
  await (await registry.connect(admin).addValuation(assetIds[0], admin.address, 45000000n, USD)).wait();
  await (await registry.connect(admin).addValuation(assetIds[0], admin.address, 48000000n, USD)).wait();

  // Industrial Land Plot (#3): single appraisal in EUR
  await (await registry.connect(admin).addValuation(assetIds[3], admin.address, 380000000n, EUR)).wait();

  // Abstract Oil Painting (#2): gallery valuation in EUR
  await (await registry.connect(admin).addValuation(assetIds[2], admin.address, 1200000n, EUR)).wait();

  // Gold Sovereign Collection (#5): Alice (current owner) adds spot-price valuation in GBP
  await (await registry.connect(alice).addValuation(assetIds[5], alice.address, 850000n, GBP)).wait();

  // Classic Sports Car (#1): Bob (current owner) adds auction-estimate valuation
  await (await registry.connect(bob).addValuation(assetIds[1], bob.address, 8500000n, USD)).wait();

  // -------------------------------------------------------------------------
  // L3 encrypted metadata
  // Posts ASSET_METADATA to L3 for each asset using the creation txId.
  // L2 must have derived Kr for these txIds before L3 can encrypt.
  // Safe to skip if L3 is not running — seed continues with a warning.
  // -------------------------------------------------------------------------
  console.log("Seeding L3 encrypted metadata (skipped if L3 is offline)...");
  for (let i = 0; i < assetFixtures.length; i++) {
    await seedL3Metadata(assetTxIds[i], assetFixtures[i].metadata);
  }

  console.log("");
  console.log("Seed complete. Summary:");
  console.log("  • 3 registered users: alice (#1), bob (#2), carol (#3)");
  console.log("  • 7 assets created and approved:");
  console.log("    Alice  → Downtown Apartment (#0), Gold Sovereign Collection (#5 from Carol)");
  console.log("    Bob    → Classic Sports Car (#1 from Alice), Abstract Oil Painting (#2), Industrial Land Plot (#3)");
  console.log("    Carol  → Vintage Rolex Watch (#4)");
  console.log("    System → Harbour Warehouse Unit (#6)");
  console.log("  • Valuations: Downtown Apartment (2×USD), Industrial Land Plot (EUR),");
  console.log("                Abstract Oil Painting (EUR), Gold Sovereign Collection (GBP), Classic Sports Car (USD)");
  console.log("  • Accounts #4+ left unregistered (for testing unregistered UX)");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
