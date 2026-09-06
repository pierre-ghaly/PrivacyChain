import { ethers, upgrades } from "hardhat";

/**
 * Upgrade script for the AssetRegistry UUPS proxy.
 *
 * How it works:
 *   1. The proxy contract (deployed once by deploy.ts) holds all state and
 *      keeps the same address forever.
 *   2. This script deploys a NEW implementation contract containing updated
 *      logic and tells the proxy to point to it.
 *   3. The proxy's `_authorizeUpgrade` requires ADMIN_ROLE, so only an
 *      authorized signer can execute this.
 *   4. Storage layout is validated automatically by @openzeppelin/hardhat-upgrades.
 *      It will reject any change that reorders, removes, or changes the type of
 *      existing state variables — only appending new ones is allowed.
 *
 * Usage:
 *   PROXY_ADDRESS=0x... npx hardhat run scripts/upgrade.ts --network <network>
 *
 * If the new implementation needs one-time initialization of newly added state,
 * add a function guarded by `reinitializer(2)` (or the next version number)
 * and call it after upgrading.
 */
async function main() {
  const proxyAddress = process.env.PROXY_ADDRESS;
  if (!proxyAddress) {
    throw new Error("Set PROXY_ADDRESS env var to the deployed proxy address");
  }

  const [deployer] = await ethers.getSigners();
  console.log("Upgrading with account:", deployer.address);
  console.log("Proxy address:", proxyAddress);

  // Replace "AssetRegistry" with "AssetRegistryV2" (or whatever the new
  // contract name is) when the upgraded logic lives in a separate file.
  const AssetRegistryV2 = await ethers.getContractFactory("AssetRegistry");

  // This call:
  //   a) Compiles and validates storage layout compatibility
  //   b) Deploys the new implementation contract
  //   c) Calls upgradeTo() on the proxy (which triggers _authorizeUpgrade)
  const upgraded = await upgrades.upgradeProxy(proxyAddress, AssetRegistryV2, {
    kind: "uups",
  });

  await upgraded.waitForDeployment();

  const implAddress = await upgrades.erc1967.getImplementationAddress(proxyAddress);

  console.log("Upgrade successful!");
  console.log("  Proxy (unchanged):", proxyAddress);
  console.log("  New implementation:", implAddress);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
