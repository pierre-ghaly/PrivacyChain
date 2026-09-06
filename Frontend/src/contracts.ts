import deployment from "../../shared/deployments/localhost.json";

export const ASSET_REGISTRY_ADDRESS = deployment.contracts.AssetRegistry.address as `0x${string}`;
export const ASSET_REGISTRY_ABI = deployment.contracts.AssetRegistry.abi;
export const SYSTEM_ADDRESS = deployment.systemAddress as `0x${string}`; // default admin

// L3 is intentionally not exposed here — the Frontend never talks to it
// directly; L2 is the sole gateway (see L2/src/routes/l3proxy.ts).
export const L2_SERVER_URL = process.env.NEXT_PUBLIC_L2_SERVER_URL || "http://127.0.0.1:3001";

// bytes3 ASCII encodings matching SmartContracts/scripts/seed.ts — must stay
// byte-exact with what addValuation() expects on-chain.
export const CURRENCY_OPTIONS = [
  { code: "USD", hex: "0x555344" },
  { code: "EUR", hex: "0x455552" },
] as const;