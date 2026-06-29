import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type DB = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS shares (
  id           TEXT PRIMARY KEY,
  token_hash   TEXT NOT NULL,
  kind         TEXT NOT NULL,
  filename     TEXT,
  mime         TEXT NOT NULL,
  blob_path    TEXT NOT NULL,
  iv           BLOB NOT NULL,
  auth_tag     BLOB NOT NULL,
  size         INTEGER NOT NULL,
  expires_at   INTEGER,
  max_accesses INTEGER,
  access_count INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_shares_token_hash ON shares (token_hash);
`;

/** Open a SQLite database and ensure the schema exists. */
export function openDb(path: string): DB {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}

let singleton: DB | null = null;

/** Process-wide database handle, rooted at DATA_DIR (default ./data). */
export function getDb(): DB {
  if (!singleton) {
    const dir = process.env.DATA_DIR ?? "./data";
    singleton = openDb(`${dir}/share.db`);
  }
  return singleton;
}
