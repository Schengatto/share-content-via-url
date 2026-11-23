import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDb, type DB } from "../lib/db";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LEGACY_PAYLOAD_FORMAT, SEALED_PAYLOAD_FORMAT } from "../lib/db";
import { deriveKey, encrypt, generateToken, hashToken } from "../lib/crypto";
import { createShare, consumeShare, revokeShare, shareStatus, ShareError } from "../lib/store";
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
    list: () => [...map.keys()],
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

describe("shareStatus", () => {
  const shareCount = () => db.prepare("SELECT COUNT(*) c FROM shares").get();

  it("reports a fresh share as available without consuming an access", async () => {
    const { token } = await createShare(db, blobs, textInput({ maxAccesses: 1 }));
    expect(shareStatus(db, token)).toEqual({ available: true });
    expect(shareStatus(db, token)).toEqual({ available: true });
    expect(db.prepare("SELECT access_count FROM shares").get()).toEqual({ access_count: 0 });
    const got = await consumeShare(db, blobs, token);
    expect(got.content.toString()).toBe("top secret");
  });

  it("reports an unknown or already used single-use token as 404", async () => {
    expect(shareStatus(db, "nonexistent-token")).toEqual({ available: false, status: 404 });
    const { token } = await createShare(db, blobs, textInput({ maxAccesses: 1 }));
    await consumeShare(db, blobs, token);
    expect(shareStatus(db, token)).toEqual({ available: false, status: 404 });
  });

  it("reports an expired share as 410 without purging it", async () => {
    const { token } = await createShare(db, blobs, textInput({ expiresAt: Date.now() - 1000 }));
    expect(shareStatus(db, token)).toEqual({ available: false, status: 410 });
    expect(shareCount()).toEqual({ c: 1 });
    expect(blobs.map.size).toBe(1);
  });

  it("reports a share with no views left as 410 without purging it", async () => {
    const { token } = await createShare(db, blobs, textInput({ maxAccesses: 2 }));
    db.prepare("UPDATE shares SET access_count = 2").run();
    expect(shareStatus(db, token)).toEqual({ available: false, status: 410 });
    expect(shareCount()).toEqual({ c: 1 });
  });
});

describe("store hardening", () => {
  const fileInput = {
    kind: "file" as const,
    content: Buffer.from("%PDF-1.7"),
    mime: "application/pdf",
    filename: "salaries-2026.pdf",
    expiresAt: null,
    maxAccesses: 1,
  };

  it("keeps filename and mime out of the database, sealed inside the ciphertext", async () => {
    const { token } = await createShare(db, blobs, fileInput);
    expect(db.prepare("SELECT payload_format, filename, mime FROM shares").get()).toEqual({
      payload_format: SEALED_PAYLOAD_FORMAT,
      filename: null,
      mime: null,
    });
    expect([...blobs.map.values()][0].includes("salaries-2026")).toBe(false);
    const got = await consumeShare(db, blobs, token);
    expect(got).toMatchObject({ kind: "file", filename: "salaries-2026.pdf", mime: "application/pdf" });
    expect(got.content.toString()).toBe("%PDF-1.7");
  });

  it("still reads a legacy share whose metadata sits in plaintext columns", async () => {
    const token = generateToken();
    const { ciphertext, iv, authTag } = encrypt(Buffer.from("legacy secret"), deriveKey(token));
    blobs.put("legacy-blob", ciphertext);
    db.prepare(
      `INSERT INTO shares (id, token_hash, kind, payload_format, filename, mime, blob_path, iv, auth_tag,
         expires_at, max_accesses, access_count, created_at)
       VALUES ('legacy', ?, 'file', ?, 'old.txt', 'text/plain', 'legacy-blob', ?, ?, NULL, 1, 0, 1)`,
    ).run(hashToken(token), LEGACY_PAYLOAD_FORMAT, iv, authTag);

    const got = await consumeShare(db, blobs, token);
    expect(got).toMatchObject({ kind: "file", filename: "old.txt", mime: "text/plain" });
    expect(got.content.toString()).toBe("legacy secret");
  });

  it("creates nothing when the blob cannot be written", async () => {
    blobs.put = () => {
      throw new Error("disk full");
    };
    await expect(createShare(db, blobs, textInput())).rejects.toThrow("disk full");
    expect(db.prepare("SELECT COUNT(*) c FROM shares").get()).toEqual({ c: 0 });
  });

  it("deletes the row before the blob, so a failing blob delete leaves no live share", async () => {
    const { token } = await createShare(db, blobs, textInput());
    blobs.delete = () => {
      throw new Error("io error");
    };
    expect(() => revokeShare(db, blobs, token)).toThrow("io error");
    expect(shareStatus(db, token)).toEqual({ available: false, status: 404 });
  });
});

describe("store on disk", () => {
  let tempDir: string;
  let fileDb: DB;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "share-store-"));
    fileDb = openDb(join(tempDir, "share.db"));
  });

  afterEach(() => {
    fileDb.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("leaves no trace of a revoked share in the database file or the WAL", async () => {
    const { token } = await createShare(fileDb, blobs, textInput());
    const tokenHash = hashToken(token);
    const databaseBytes = () =>
      Buffer.concat([readFileSync(join(tempDir, "share.db")), readFileSync(join(tempDir, "share.db-wal"))]);
    expect(databaseBytes().includes(tokenHash)).toBe(true);

    revokeShare(fileDb, blobs, token);

    expect(statSync(join(tempDir, "share.db-wal")).size).toBe(0);
    expect(databaseBytes().includes(tokenHash)).toBe(false);
  });
});
