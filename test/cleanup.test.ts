import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type DB } from "../lib/db";
import { createShare } from "../lib/store";
import { purgeExpired } from "../lib/cleanup";
import type { BlobStore } from "../lib/blob-store";

function memBlobs(): BlobStore & { map: Map<string, Buffer> } {
  const map = new Map<string, Buffer>();
  return {
    map,
    put: (id, d) => void map.set(id, d),
    get: (id) => map.get(id)!,
    delete: (id) => void map.delete(id),
  };
}

let db: DB;
let blobs: ReturnType<typeof memBlobs>;

beforeEach(() => {
  db = openDb(":memory:");
  blobs = memBlobs();
});

const base = {
  kind: "text" as const,
  content: Buffer.from("x"),
  mime: "text/plain",
};

describe("cleanup.purgeExpired", () => {
  it("removes time-expired shares and their blobs, keeps valid ones", async () => {
    await createShare(db, blobs, { ...base, expiresAt: Date.now() - 1000 });
    await createShare(db, blobs, { ...base, expiresAt: Date.now() + 60_000 });

    const removed = purgeExpired(db, blobs);

    expect(removed).toBe(1);
    expect(db.prepare("SELECT COUNT(*) c FROM shares").get()).toEqual({ c: 1 });
    expect(blobs.map.size).toBe(1);
  });

  it("removes access-exhausted shares", async () => {
    const { id } = await createShare(db, blobs, { ...base, maxAccesses: 1 });
    db.prepare("UPDATE shares SET access_count = 1 WHERE id = ?").run(id);

    expect(purgeExpired(db, blobs)).toBe(1);
    expect(db.prepare("SELECT COUNT(*) c FROM shares").get()).toEqual({ c: 0 });
    expect(blobs.map.size).toBe(0);
  });

  it("returns 0 when nothing is expired", async () => {
    await createShare(db, blobs, { ...base, expiresAt: Date.now() + 60_000 });
    expect(purgeExpired(db, blobs)).toBe(0);
  });
});
