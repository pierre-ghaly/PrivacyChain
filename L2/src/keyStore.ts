import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { config } from './config';
import { deriveKr, generateNonce, encryptBuffer, decryptBuffer } from './crypto';

export type AssertionStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export interface FinancialAssertion {
  txId: string;
  assetId: string;
  submittedBy: string;
  counterparty: string | null;
  status: AssertionStatus;
  // Both booleans, not a single 'CONFIRMED' status — a sale-price proposal
  // needs each side tracked independently (see AssetRegistry.confirmFinancialAssertion).
  // A solo valuation (counterparty null) never needs either to be true.
  sellerConfirmed: boolean;
  buyerConfirmed: boolean;
  createdAt: number;
  decidedAt: number | null;
  decidedBy: string | null;
}

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

      CREATE TABLE IF NOT EXISTS financial_assertions (
        txId            TEXT PRIMARY KEY,
        assetId         TEXT NOT NULL,
        submittedBy     TEXT NOT NULL,
        counterparty    TEXT,
        status          TEXT NOT NULL DEFAULT 'PENDING',
        sellerConfirmed INTEGER NOT NULL DEFAULT 0,
        buyerConfirmed  INTEGER NOT NULL DEFAULT 0,
        createdAt       INTEGER NOT NULL,
        decidedAt       INTEGER,
        decidedBy       TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_assertions_asset ON financial_assertions(assetId);
      CREATE INDEX IF NOT EXISTS idx_assertions_counterparty ON financial_assertions(counterparty);
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

  // Destroys a single key by txId — unlike destroyKeysForUser (per-user, used
  // for RTBF exit), this must not touch any other keys the same owner holds.
  // Used for reject/decline (a rejected asset or financial assertion) — its
  // owner's other, unrelated keys must stay untouched.
  destroyKey(txId: string): void {
    this.db.prepare(`
      UPDATE keys SET destroyed = 1, destroyedAt = ?, encryptedKr = '', nonce = NULL
      WHERE txId = ? AND destroyed = 0
    `).run(Date.now(), txId);
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

  // -------------------------------------------------------------------------
  // Financial assertions (valuations, sale-price proposals) — see
  // eventListener.ts's onFinancialAssertionRequested/Decided and
  // routes/assertions.ts. Deliberately no `assertionType` column: whether a
  // row is a solo valuation or a sale-price proposal is derived from
  // counterparty IS NULL vs. not, both here and in the L3 dataType string
  // the Frontend picks when it POSTs the actual content.
  // -------------------------------------------------------------------------

  createAssertion(params: {
    txId: string;
    assetId: string;
    submittedBy: string;
    counterparty: string | null;
    status: AssertionStatus;
  }): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO financial_assertions (txId, assetId, submittedBy, counterparty, status, createdAt)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      params.txId,
      params.assetId,
      params.submittedBy.toLowerCase(),
      params.counterparty ? params.counterparty.toLowerCase() : null,
      params.status,
      Date.now(),
    );
  }

  // better-sqlite3 returns INTEGER columns as raw 0/1, not real booleans —
  // convert here so FinancialAssertion's public shape (and its JSON
  // serialization out through routes/assertions.ts) is honestly typed.
  private _mapAssertionRow(row: any): FinancialAssertion {
    return { ...row, sellerConfirmed: !!row.sellerConfirmed, buyerConfirmed: !!row.buyerConfirmed };
  }

  getAssertion(txId: string): FinancialAssertion | null {
    const row = this.db.prepare('SELECT * FROM financial_assertions WHERE txId = ?').get(txId) as any;
    return row ? this._mapAssertionRow(row) : null;
  }

  listAssertionsForAsset(assetId: string): FinancialAssertion[] {
    const rows = this.db
      .prepare('SELECT * FROM financial_assertions WHERE assetId = ? ORDER BY createdAt DESC')
      .all(assetId) as any[];
    return rows.map(r => this._mapAssertionRow(r));
  }

  listAssertionsForUser(userAddress: string): FinancialAssertion[] {
    const lower = userAddress.toLowerCase();
    const rows = this.db
      .prepare('SELECT * FROM financial_assertions WHERE submittedBy = ? OR counterparty = ? ORDER BY createdAt DESC')
      .all(lower, lower) as any[];
    return rows.map(r => this._mapAssertionRow(r));
  }

  // Admin's review queue — sellerConfirmed/buyerConfirmed are surfaced
  // per-row so the UI can show "waiting on buyer" etc.; a row here may or
  // may not be ready for on-chain approval yet (see AssetRegistry's
  // FinancialAssertionLib.isReadyForApproval, which is the actual gate).
  listPendingAssertions(): FinancialAssertion[] {
    const rows = this.db
      .prepare("SELECT * FROM financial_assertions WHERE status = 'PENDING' ORDER BY createdAt ASC")
      .all() as any[];
    return rows.map(r => this._mapAssertionRow(r));
  }

  // Reacts to AssetRegistry's FinancialAssertionConfirmed event (see
  // eventListener.ts's onFinancialAssertionConfirmed) — confirmation itself
  // is an on-chain transaction (confirmFinancialAssertion), not an L2
  // API call; this just mirrors the resulting state into L2's local view of
  // the row so the Frontend doesn't need a separate L1 read for display.
  recordConfirmation(txId: string, confirmedBy: string): void {
    const row = this.getAssertion(txId);
    if (!row) return;
    const lower = confirmedBy.toLowerCase();
    if (lower === row.submittedBy) {
      this.db.prepare('UPDATE financial_assertions SET sellerConfirmed = 1 WHERE txId = ?').run(txId);
    } else if (row.counterparty && lower === row.counterparty) {
      this.db.prepare('UPDATE financial_assertions SET buyerConfirmed = 1 WHERE txId = ?').run(txId);
    }
  }

  // Admin's on-chain decision, mirrored into L2's local view of the row —
  // called from eventListener.ts's onFinancialAssertionDecided, not directly
  // from a route (the decision itself is an L1 transaction, see AssetRegistry.decideFinancialAssertion).
  decideAssertion(txId: string, status: 'APPROVED' | 'REJECTED', decidedBy: string): void {
    this.db.prepare(`
      UPDATE financial_assertions SET status = ?, decidedAt = ?, decidedBy = ?
      WHERE txId = ?
    `).run(status, Date.now(), decidedBy.toLowerCase(), txId);
  }
}
