import { config as dotenvConfig } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

dotenvConfig();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const config = {
  port: parseInt(process.env.L3_PORT ?? '3002', 10),
  l2Url: process.env.L2_URL ?? 'http://127.0.0.1:3001',
  storagePath: process.env.L3_STORAGE_PATH
    ?? resolve(__dirname, '..', '.data', 'ipfs'),
  // L3's own (txId, dataType) -> CID index — L2 no longer tracks this;
  // L3 is self-contained for resolving its own data. Sits alongside
  // storagePath under .data/, so dev-up.sh's existing `rm -rf L3/.data`
  // wipe (done for an unrelated libp2p reason) clears this too.
  cidDbPath: process.env.L3_CID_DB_PATH
    ?? resolve(__dirname, '..', '.data', 'cids.db'),
  // Shared secret gating every route but /health — L3's stand-in for real
  // network isolation (both services run on localhost in this demo, so an
  // IP-based restriction can't actually distinguish "L2" from anything else
  // on the same machine). Must match L2's L3_INTERNAL_KEY exactly.
  internalKey: process.env.L3_INTERNAL_KEY
    ?? 'dev-only-l2-l3-shared-secret-change-in-production',
};
