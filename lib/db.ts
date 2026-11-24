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

export const LEGACY_PAYLOAD_FORMAT = 1;
export const SEALED_PAYLOAD_FORMAT = 2;
export const E2E_V1_PAYLOAD_FORMAT = 3;

const MIGRATIONS = [
  `CREATE TABLE shares_sealed (
     id             TEXT PRIMARY KEY,
     token_hash     TEXT NOT NULL,
     kind           TEXT NOT NULL,
     payload_format INTEGER NOT NULL DEFAULT ${SEALED_PAYLOAD_FORMAT},
     filename       TEXT,
     mime           TEXT,
     blob_path      TEXT NOT NULL,
     iv             BLOB NOT NULL,
     auth_tag       BLOB NOT NULL,
     expires_at     INTEGER,
     max_accesses   INTEGER,
     access_count   INTEGER NOT NULL DEFAULT 0,
     created_at     INTEGER NOT NULL
   );
   INSERT INTO shares_sealed
     (id, token_hash, kind, payload_format, filename, mime, blob_path, iv, auth_tag,
      expires_at, max_accesses, access_count, created_at)
   SELECT id, token_hash, kind, ${LEGACY_PAYLOAD_FORMAT}, filename, mime, blob_path, iv, auth_tag,
          expires_at, max_accesses, access_count, created_at
   FROM shares;
   DROP TABLE shares;
   ALTER TABLE shares_sealed RENAME TO shares;
   CREATE UNIQUE INDEX idx_shares_token_hash ON shares (token_hash);`,
  `ALTER TABLE shares ADD COLUMN password_hash TEXT;
   ALTER TABLE shares ADD COLUMN locked_until INTEGER;`,
  `ALTER TABLE shares ADD COLUMN revoke_token_hash TEXT;`,
  `ALTER TABLE shares ADD COLUMN failed_attempts INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE shares ADD COLUMN lockouts INTEGER NOT NULL DEFAULT 0;`,
  `ALTER TABLE shares ADD COLUMN e2e_salt BLOB;
   ALTER TABLE shares ADD COLUMN e2e_kdf_iterations INTEGER;
   ALTER TABLE shares ADD COLUMN link_proof_hash TEXT;
   ALTER TABLE shares ADD COLUMN auth_hash TEXT;`,
  `ALTER TABLE shares ADD COLUMN password_key_salt BLOB;`,
];

function migrate(db: DB): void {
  const appliedVersion = db.pragma("user_version", { simple: true }) as number;
  if (appliedVersion > MIGRATIONS.length) {
    throw new Error(
      `Database schema version ${appliedVersion} is newer than this app supports (${MIGRATIONS.length}). Upgrade the app before opening this database.`,
    );
  }
  for (let version = appliedVersion; version < MIGRATIONS.length; version++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[version]);
      db.pragma(`user_version = ${version + 1}`);
    })();
  }
}

export function scrubDeletedData(db: DB): void {
  db.pragma("wal_checkpoint(TRUNCATE)");
}

/** Open a SQLite database and ensure the schema exists. */
export function openDb(path: string): DB {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("secure_delete = ON");
  try {
    db.exec(SCHEMA);
    migrate(db);
  } catch (error) {
    db.close();
    throw error;
  }
  scrubDeletedData(db);
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
