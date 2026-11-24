import { describe, it, expect, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LEGACY_PAYLOAD_FORMAT, openDb } from "../lib/db";

const LEGACY_SCHEMA = `
CREATE TABLE shares (
  id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, kind TEXT NOT NULL, filename TEXT,
  mime TEXT NOT NULL, blob_path TEXT NOT NULL, iv BLOB NOT NULL, auth_tag BLOB NOT NULL,
  size INTEGER NOT NULL, expires_at INTEGER, max_accesses INTEGER,
  access_count INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_shares_token_hash ON shares (token_hash);
`;

const VERSION_FOUR_SCHEMA = `
CREATE TABLE shares (
  id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, kind TEXT NOT NULL,
  payload_format INTEGER NOT NULL DEFAULT 2, filename TEXT, mime TEXT, blob_path TEXT NOT NULL,
  iv BLOB NOT NULL, auth_tag BLOB NOT NULL, expires_at INTEGER, max_accesses INTEGER,
  access_count INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, password_hash TEXT,
  locked_until INTEGER, revoke_token_hash TEXT, failed_attempts INTEGER NOT NULL DEFAULT 0,
  lockouts INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX idx_shares_token_hash ON shares (token_hash);
`;

let tempDir: string | null = null;

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe("db", () => {
  it("creates the shares table without plaintext size and with the payload format", () => {
    const db = openDb(":memory:");
    const cols = (
      db.prepare("PRAGMA table_info(shares)").all() as { name: string }[]
    ).map((c) => c.name);
    expect(cols).toEqual([
      "id",
      "token_hash",
      "kind",
      "payload_format",
      "filename",
      "mime",
      "blob_path",
      "iv",
      "auth_tag",
      "expires_at",
      "max_accesses",
      "access_count",
      "created_at",
      "password_hash",
      "locked_until",
      "revoke_token_hash",
      "failed_attempts",
      "lockouts",
      "e2e_salt",
      "e2e_kdf_iterations",
      "link_proof_hash",
      "auth_hash",
    ]);
    expect(db.pragma("user_version", { simple: true })).toBe(5);
  });

  it("indexes token_hash for lookup", () => {
    const db = openDb(":memory:");
    const indexes = (
      db.prepare("PRAGMA index_list(shares)").all() as { name: string }[]
    ).map((i) => i.name);
    expect(indexes.some((n) => n.includes("token_hash"))).toBe(true);
  });

  it("migration is idempotent", () => {
    const db = openDb(":memory:");
    expect(() => openDb(":memory:")).not.toThrow();
    expect(db.prepare("SELECT COUNT(*) c FROM shares").get()).toEqual({ c: 0 });
  });

  it("zeroes deleted content", () => {
    const db = openDb(":memory:");
    expect(db.pragma("secure_delete", { simple: true })).toBe(1);
  });

  it("migrates a legacy database keeping its shares readable as the legacy payload format", () => {
    tempDir = mkdtempSync(join(tmpdir(), "share-db-"));
    const path = join(tempDir, "share.db");
    const legacy = new Database(path);
    legacy.exec(LEGACY_SCHEMA);
    legacy
      .prepare(
        `INSERT INTO shares (id, token_hash, kind, filename, mime, blob_path, iv, auth_tag, size,
           expires_at, max_accesses, access_count, created_at)
         VALUES ('share-1', 'hash-1', 'file', 'a.pdf', 'application/pdf', 'share-1', x'00', x'00', 3,
           NULL, 1, 0, 1)`,
      )
      .run();
    legacy.close();

    const db = openDb(path);
    expect(db.pragma("user_version", { simple: true })).toBe(5);
    expect(
      db
        .prepare(
          "SELECT payload_format, filename, mime, access_count, password_hash, locked_until, revoke_token_hash, failed_attempts, lockouts FROM shares WHERE id = 'share-1'",
        )
        .get(),
    ).toEqual({
      payload_format: LEGACY_PAYLOAD_FORMAT,
      filename: "a.pdf",
      mime: "application/pdf",
      access_count: 0,
      password_hash: null,
      locked_until: null,
      revoke_token_hash: null,
      failed_attempts: 0,
      lockouts: 0,
    });
    db.close();
    const reopened = openDb(path);
    expect(reopened.pragma("user_version", { simple: true })).toBe(5);
    reopened.close();
  });

  it("migrates a version 4 database to version 5 keeping its shares", () => {
    tempDir = mkdtempSync(join(tmpdir(), "share-db-"));
    const path = join(tempDir, "share.db");
    const versionFour = new Database(path);
    versionFour.exec(VERSION_FOUR_SCHEMA);
    versionFour
      .prepare(
        `INSERT INTO shares (id, token_hash, kind, payload_format, mime, blob_path, iv, auth_tag,
           expires_at, max_accesses, access_count, created_at, password_hash)
         VALUES ('share-4', 'hash-4', 'text', 2, NULL, 'share-4', x'00', x'00', NULL, 3, 1, 1, 'scrypt$x')`,
      )
      .run();
    versionFour.pragma("user_version = 4");
    versionFour.close();

    const db = openDb(path);
    expect(db.pragma("user_version", { simple: true })).toBe(5);
    expect(
      db
        .prepare(
          "SELECT payload_format, access_count, password_hash, e2e_salt, e2e_kdf_iterations, link_proof_hash, auth_hash FROM shares WHERE id = 'share-4'",
        )
        .get(),
    ).toEqual({
      payload_format: 2,
      access_count: 1,
      password_hash: "scrypt$x",
      e2e_salt: null,
      e2e_kdf_iterations: null,
      link_proof_hash: null,
      auth_hash: null,
    });
    db.close();
  });

  it("refuses to open a database migrated by a newer version of the app", () => {
    tempDir = mkdtempSync(join(tmpdir(), "share-db-"));
    const path = join(tempDir, "share.db");
    const newer = new Database(path);
    newer.pragma("user_version = 6");
    newer.close();
    expect(() => openDb(path)).toThrow("Database schema version 6 is newer than this app supports (5)");
  });
});
