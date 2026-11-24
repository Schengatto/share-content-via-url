import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type DB } from "../lib/db";
import { createShare } from "../lib/store";
import { purgeExpired } from "../lib/cleanup";
import type { BlobStore } from "../lib/blob-store";
import { MAX_TTL_SECONDS, MIN_TTL_SECONDS } from "../lib/share-options";

function memBlobs(): BlobStore & { map: Map<string, Buffer> } {
  const map = new Map<string, Buffer>();
  return {
    map,
    put: (id, d) => void map.set(id, d),
    get: (id) => map.get(id)!,
    delete: (id) => void map.delete(id),
    list: () => [...map.keys()],
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
  ttlSeconds: MAX_TTL_SECONDS,
  maxAccesses: 1,
};
const AFTER_SHORTEST_LIFETIME = () => Date.now() + MIN_TTL_SECONDS * 1000 + 1000;

describe("cleanup.purgeExpired", () => {
  it("removes time-expired shares and their blobs, keeps valid ones", async () => {
    await createShare(db, blobs, { ...base, ttlSeconds: MIN_TTL_SECONDS });
    await createShare(db, blobs, base);

    const removed = purgeExpired(db, blobs, AFTER_SHORTEST_LIFETIME());

    expect(removed).toBe(1);
    expect(db.prepare("SELECT COUNT(*) c FROM shares").get()).toEqual({ c: 1 });
    expect(blobs.map.size).toBe(1);
  });

  it("removes access-exhausted shares", async () => {
    const { id } = await createShare(db, blobs, base);
    db.prepare("UPDATE shares SET access_count = 1 WHERE id = ?").run(id);

    expect(purgeExpired(db, blobs)).toBe(1);
    expect(db.prepare("SELECT COUNT(*) c FROM shares").get()).toEqual({ c: 0 });
    expect(blobs.map.size).toBe(0);
  });

  it("returns 0 when nothing is expired", async () => {
    await createShare(db, blobs, base);
    expect(purgeExpired(db, blobs, AFTER_SHORTEST_LIFETIME())).toBe(0);
  });

  it("removes blobs that no share references and keeps referenced ones", async () => {
    const { id } = await createShare(db, blobs, base);
    blobs.put("orphan-blob", Buffer.from("leftover ciphertext"));

    expect(purgeExpired(db, blobs)).toBe(0);
    expect([...blobs.map.keys()]).toEqual([id]);
  });
});
