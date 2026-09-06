import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { config } from './config';
import { deriveKr, generateNonce, encryptBuffer, decryptBuffer } from './crypto';

export class KeyStore {
  private db: Database.Database;

  constructor() {
    fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
    this.db = new Database(config.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS keys (
        txId        TEXT    PRIMARY KEY,
        userAddress TEXT    NOT NULL,
        encryptedKr TEXT    NOT NULL,
        nonce       TEXT,
        createdAt   INTEGER NOT NULL,
        destroyed   INTEGER NOT NULL DEFAULT 0,
        destroyedAt INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_keys_user ON keys(userAddress);

      CREATE TABLE IF NOT EXISTS asset_txids (
        assetId  TEXT PRIMARY KEY,
        txId     TEXT NOT NULL
      );
    `);
  }

  storeKey(txId: string, userAddress: string): void {
    if (this.keyExists(txId)) return; // idempotent
    const nonce = generateNonce();
    const kr = deriveKr(txId, nonce);
    const encryptedKr = encryptBuffer(kr, config.dbMasterKey);
    this.db.prepare(`
      INSERT OR IGNORE INTO keys (txId, userAddress, encryptedKr, nonce, createdAt, destroyed)
      VALUES (?, ?, ?, ?, ?, 0)
    `).run(txId, userAddress.toLowerCase(), encryptedKr, nonce.toString('hex'), Date.now());
  }

  // Returns the decrypted Kr, or null if not found or destroyed.
  getKey(txId: string): Buffer | null {
    const row = this.db
      .prepare('SELECT encryptedKr, destroyed FROM keys WHERE txId = ?')
      .get(txId) as { encryptedKr: string; destroyed: number } | undefined;
    if (!row) return null;
    if (row.destroyed) return null;
    return decryptBuffer(row.encryptedKr, config.dbMasterKey);
  }

  // Destroys all active keys for a user: zeroes out the cached key material
  // (encryptedKr) AND deletes the nonce that deriveKr needs to reconstruct Kr.
  // The row is kept for audit trail, but this is not just an access-control
  // flag — with the nonce gone, Kr cannot be recomputed by anyone, even with
  // full knowledge of masterSalt and txId. Setting destroyed=0 afterwards
  // cannot recover anything.
  // Returns the list of txIds that were destroyed.
  destroyKeysForUser(userAddress: string): string[] {
    const rows = this.db
      .prepare('SELECT txId FROM keys WHERE userAddress = ? AND destroyed = 0')
      .all(userAddress.toLowerCase()) as { txId: string }[];
    if (rows.length === 0) return [];
    this.db.prepare(`
      UPDATE keys SET destroyed = 1, destroyedAt = ?, encryptedKr = '', nonce = NULL
      WHERE userAddress = ? AND destroyed = 0
    `).run(Date.now(), userAddress.toLowerCase());
    return rows.map(r => r.txId);
  }

  // The address a txId's key is currently bound to — reflects re-keying, so
  // after a transfer this returns the new owner, not the original creator.
  getKeyOwner(txId: string): string | null {
    const row = this.db
      .prepare('SELECT userAddress FROM keys WHERE txId = ?')
      .get(txId) as { userAddress: string } | undefined;
    return row?.userAddress ?? null;
  }

  isKeyDestroyed(txId: string): boolean {
    const row = this.db
      .prepare('SELECT destroyed FROM keys WHERE txId = ?')
      .get(txId) as { destroyed: number } | undefined;
    return row?.destroyed === 1;
  }

  keyExists(txId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM keys WHERE txId = ?').get(txId);
  }

  getDestroyedTxIds(userAddress: string): string[] {
    const rows = this.db
      .prepare('SELECT txId FROM keys WHERE userAddress = ? AND destroyed = 1')
      .all(userAddress.toLowerCase()) as { txId: string }[];
    return rows.map(r => r.txId);
  }

  getUserTxIds(userAddress: string): string[] {
    const rows = this.db
      .prepare('SELECT txId FROM keys WHERE userAddress = ?')
      .all(userAddress.toLowerCase()) as { txId: string }[];
    return rows.map(r => r.txId);
  }

  storeAssetTxId(assetId: string, txId: string): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO asset_txids (assetId, txId) VALUES (?, ?)
    `).run(assetId, txId);
  }

  // Repoints an asset at a new txId after a successful re-key (see rekey.ts).
  // Unlike storeAssetTxId (set-once, at creation), this must overwrite.
  setAssetTxId(assetId: string, txId: string): void {
    this.db.prepare(`
      INSERT INTO asset_txids (assetId, txId) VALUES (?, ?)
      ON CONFLICT(assetId) DO UPDATE SET txId = excluded.txId
    `).run(assetId, txId);
  }

  getAssetTxId(assetId: string): string | null {
    const row = this.db
      .prepare('SELECT txId FROM asset_txids WHERE assetId = ?')
      .get(assetId) as { txId: string } | undefined;
    return row?.txId ?? null;
  }
}
