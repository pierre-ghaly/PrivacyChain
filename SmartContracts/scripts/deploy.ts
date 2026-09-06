import { ethers, upgrades, network, artifacts } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * Initial deployment script for the AssetRegistry UUPS proxy.
 *
 * Deploys the proxy + implementation, calls initialize(), and writes a
 * deployment artifact to ../shared/deployments/<network>.json so the
 * frontend can import the ABI and address directly (single source of truth,
 * no ABI drift).
 *
 * Environment variables:
 *   SYSTEM_ADDRESS  (optional) — overrides the canonical system address.
 *                   Defaults to the deployer if not set.
 *
 * Usage:
 *   npx hardhat run scripts/deploy.ts --network <network>
 */
async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Network:           ", network.name);
  console.log("Deploying as:      ", deployer.address);

  const systemAddress = process.env.SYSTEM_ADDRESS ?? deployer.address;
  console.log("System address:    ", systemAddress);

  const AssetRegistry = await ethers.getContractFactory("AssetRegistry");

  const assetRegistry = await upgrades.deployProxy(
    AssetRegistry,
    [deployer.address, systemAddress],
    { initializer: "initialize", kind: "uups" }
  );

  await assetRegistry.waitForDeployment();

  const proxyAddress = await assetRegistry.getAddress();
  console.log("AssetRegistry Proxy:", proxyAddress);

  // Export deployment artifact to the shared folder so the frontend can consume it.
  const artifact = await artifacts.readArtifact("AssetRegistry");
  const chainId = Number((await ethers.provider.getNetwork()).chainId);

  const deployment = {
    network: network.name,
    chainId,
    deployer: deployer.address,
    systemAddress,
    deployedAt: new Date().toISOString(),
    contracts: {
      AssetRegistry: {
        address: proxyAddress,
        abi: artifact.abi,
      },
    },
  };

  const sharedDir = path.resolve(__dirname, "..", "..", "shared", "deployments");
  fs.mkdirSync(sharedDir, { recursive: true });
  const outFile = path.join(sharedDir, `${network.name}.json`);
  fs.writeFileSync(outFile, JSON.stringify(deployment, null, 2));
  console.log("Deployment written: ", outFile);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
