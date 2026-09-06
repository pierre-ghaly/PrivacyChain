import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config();

const dbMasterKeyHex = process.env.L2_DB_MASTER_KEY ?? '0'.repeat(64);
if (dbMasterKeyHex.length !== 64) {
  throw new Error('L2_DB_MASTER_KEY must be exactly 64 hex characters (32 bytes)');
}

export const config = {
  port: parseInt(process.env.L2_PORT ?? '3001', 10),
  l1WsUrl: process.env.L1_WS_URL ?? 'ws://127.0.0.1:8545',
  l3Url: process.env.L3_URL ?? 'http://127.0.0.1:3002',
  masterSalt: process.env.L2_MASTER_SALT ?? 'privacychain-dev-salt-change-in-production',
  dbPath: process.env.L2_DB_PATH ?? path.join(__dirname, '..', '.data', 'keys.db'),
  dbMasterKey: Buffer.from(dbMasterKeyHex, 'hex'),
  adminPrivateKey: process.env.L2_ADMIN_PRIVATE_KEY
    ?? '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  deploymentFile: process.env.DEPLOYMENT_FILE
    ?? path.resolve(__dirname, '..', '..', '..', 'shared', 'deployments', 'localhost.json'),
  authSessionTtlMs: parseInt(process.env.L2_AUTH_SESSION_TTL_MS ?? '3600000', 10),
  // Must match L3's L3_INTERNAL_KEY exactly — see L3/src/config.ts.
  l3InternalKey: process.env.L3_INTERNAL_KEY
    ?? 'dev-only-l2-l3-shared-secret-change-in-production',
};
