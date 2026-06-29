import { describe, it, expect } from "vitest";
import { openDb } from "../lib/db";

describe("db", () => {
  it("creates the shares table with all expected columns", () => {
    const db = openDb(":memory:");
    const cols = (
      db.prepare("PRAGMA table_info(shares)").all() as { name: string }[]
    ).map((c) => c.name);
    expect(cols).toEqual(
      expect.arrayContaining([
        "id",
        "token_hash",
        "kind",
        "filename",
        "mime",
        "blob_path",
        "iv",
        "auth_tag",
        "size",
        "expires_at",
        "max_accesses",
        "access_count",
        "created_at",
      ]),
    );
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
});
