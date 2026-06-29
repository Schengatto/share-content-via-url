import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type DB } from "../lib/db";
import { createShare, consumeShare, ShareError } from "../lib/store";
import type { BlobStore } from "../lib/blob-store";

function memBlobs(): BlobStore & { map: Map<string, Buffer> } {
  const map = new Map<string, Buffer>();
  return {
    map,
    put: (id, data) => {
      map.set(id, data);
    },
    get: (id) => {
      const b = map.get(id);
      if (!b) throw new Error(`no blob ${id}`);
      return b;
    },
    delete: (id) => {
      map.delete(id);
    },
  };
}

let db: DB;
let blobs: ReturnType<typeof memBlobs>;

beforeEach(() => {
  db = openDb(":memory:");
  blobs = memBlobs();
});

const textInput = (over: Partial<Parameters<typeof createShare>[2]> = {}) => ({
  kind: "text" as const,
  content: Buffer.from("top secret"),
  mime: "text/plain",
  expiresAt: null,
  maxAccesses: null,
  ...over,
});

describe("store", () => {
  it("round-trips: create then consume returns the original content", async () => {
    const { token } = await createShare(db, blobs, textInput());
    const got = await consumeShare(db, blobs, token);
    expect(got.content.toString()).toBe("top secret");
    expect(got.kind).toBe("text");
    expect(got.mime).toBe("text/plain");
  });

  it("does not persist the token, only its hash", async () => {
    const { token } = await createShare(db, blobs, textInput());
    const row = db.prepare("SELECT token_hash FROM shares").get() as {
      token_hash: string;
    };
    expect(row.token_hash).not.toBe(token);
    expect(row.token_hash).toHaveLength(64);
  });

  it("returns 404 for an unknown token", async () => {
    await expect(consumeShare(db, blobs, "nonexistent-token")).rejects.toMatchObject(
      { status: 404 },
    );
  });

  it("consumes a single-use share once, then purges it (re-access 404)", async () => {
    const { token } = await createShare(db, blobs, textInput({ maxAccesses: 1 }));
    await consumeShare(db, blobs, token);
    // Exhausted shares are purged, so the token no longer exists -> 404.
    await expect(consumeShare(db, blobs, token)).rejects.toMatchObject({
      status: 404,
    });
    expect(db.prepare("SELECT COUNT(*) c FROM shares").get()).toEqual({ c: 0 });
    expect(blobs.map.size).toBe(0);
  });

  it("allows exactly max_accesses consumptions then purges (atomic counting)", async () => {
    const { token } = await createShare(db, blobs, textInput({ maxAccesses: 3 }));
    await consumeShare(db, blobs, token);
    await consumeShare(db, blobs, token);
    await consumeShare(db, blobs, token);
    await expect(consumeShare(db, blobs, token)).rejects.toMatchObject({
      status: 404,
    });
    expect(db.prepare("SELECT COUNT(*) c FROM shares").get()).toEqual({ c: 0 });
  });

  it("returns 410 once the timestamp has expired and purges it", async () => {
    const { token } = await createShare(
      db,
      blobs,
      textInput({ expiresAt: Date.now() - 1000 }),
    );
    await expect(consumeShare(db, blobs, token)).rejects.toMatchObject({
      status: 410,
    });
    expect(db.prepare("SELECT COUNT(*) c FROM shares").get()).toEqual({ c: 0 });
  });

  it("still works before the timestamp expires", async () => {
    const { token } = await createShare(
      db,
      blobs,
      textInput({ expiresAt: Date.now() + 60_000 }),
    );
    const got = await consumeShare(db, blobs, token);
    expect(got.content.toString()).toBe("top secret");
  });

  it("rejects an out-of-range max_accesses with 400", async () => {
    await expect(
      createShare(db, blobs, textInput({ maxAccesses: 5 })),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("preserves filename and mime for file shares", async () => {
    const { token } = await createShare(db, blobs, {
      kind: "file",
      content: Buffer.from([1, 2, 3, 4]),
      mime: "image/png",
      filename: "pic.png",
      expiresAt: null,
      maxAccesses: 1,
    });
    const got = await consumeShare(db, blobs, token);
    expect(got.filename).toBe("pic.png");
    expect(got.mime).toBe("image/png");
    expect([...got.content]).toEqual([1, 2, 3, 4]);
  });

  it("exposes ShareError with status and code", () => {
    const e = new ShareError("gone", 410, "GONE");
    expect(e).toBeInstanceOf(Error);
    expect(e.status).toBe(410);
    expect(e.code).toBe("GONE");
  });
});
