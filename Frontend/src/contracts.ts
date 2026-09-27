import deployment from "../../shared/deployments/localhost.json";

export const ASSET_REGISTRY_ADDRESS = deployment.contracts.AssetRegistry.address as `0x${string}`;
export const ASSET_REGISTRY_ABI = deployment.contracts.AssetRegistry.abi;
export const SYSTEM_ADDRESS = deployment.systemAddress as `0x${string}`; // default admin

// L3 is intentionally not exposed here — the Frontend never talks to it
// directly; L2 is the sole gateway (see L2/src/routes/l3proxy.ts).
export const L2_SERVER_URL = process.env.NEXT_PUBLIC_L2_SERVER_URL || "http://127.0.0.1:3001";

// Financial assertions (valuations, sale price) are off-chain L3 content —
// no bytes3 on-chain encoding constraint applies anymore, just plain strings.
export const CURRENCY_OPTIONS = ["USD", "EUR", "GBP"] as const;