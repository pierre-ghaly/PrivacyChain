import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { config } from './config.js';

// L3's own (txId, dataType) -> CID index. Previously this lived in L2
// (round-tripping through POST /keys/cids after every store); now L3 is
// fully self-contained for resolving its own data, and L2 never sees a CID
// at all for the metadata lookup path (see GET /retrieve/by-tx/:txId).
let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (!db) {
    fs.mkdirSync(path.dirname(config.cidDbPath), { recursive: true });
    db = new Database(config.cidDbPath);
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS cids (
        txId      TEXT NOT NULL,
        dataType  TEXT NOT NULL,
        cid       TEXT NOT NULL,
        storedAt  INTEGER NOT NULL,
        PRIMARY KEY (txId, dataType)
      );
    `);
  }
  return db;
}

export function storeCid(txId: string, dataType: string, cid: string): void {
  getDb().prepare(`
    INSERT OR REPLACE INTO cids (txId, dataType, cid, storedAt) VALUES (?, ?, ?, ?)
  `).run(txId, dataType, cid, Date.now());
}

export function getCid(txId: string, dataType: string): string | null {
  const row = getDb()
    .prepare('SELECT cid FROM cids WHERE txId = ? AND dataType = ?')
    .get(txId, dataType) as { cid: string } | undefined;
  return row?.cid ?? null;
}
