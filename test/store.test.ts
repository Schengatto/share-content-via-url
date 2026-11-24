import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { openDb, type DB } from "../lib/db";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LEGACY_PAYLOAD_FORMAT, SEALED_PAYLOAD_FORMAT } from "../lib/db";
import { deriveKey, encrypt, generateToken, hashToken } from "../lib/crypto";
import { createShare, consumeShare, revokeShare, shareStatus, ShareError } from "../lib/store";
import type { BlobStore } from "../lib/blob-store";
import { DEFAULT_TTL_SECONDS, LOCK_DURATION_MS, MAX_TTL_SECONDS, MIN_TTL_SECONDS } from "../lib/share-options";

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
  ttlSeconds: DEFAULT_TTL_SECONDS,
  maxAccesses: 1,
  ...over,
});

async function openShare(token: string, password?: string) {
  const outcome = await consumeShare(db, blobs, token, password);
  if (outcome.status !== "opened") throw new Error(`share not opened: ${outcome.status}`);
  return outcome.share;
}

function expireAllShares() {
  db.prepare("UPDATE shares SET expires_at = ?").run(Date.now() - 1000);
}

describe("store", () => {
  it("round-trips: create then consume returns the original content", async () => {
    const { token } = await createShare(db, blobs, textInput());
    const got = await openShare(token);
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
    const { token } = await createShare(db, blobs, textInput());
    expireAllShares();
    await expect(consumeShare(db, blobs, token)).rejects.toMatchObject({
      status: 410,
    });
    expect(db.prepare("SELECT COUNT(*) c FROM shares").get()).toEqual({ c: 0 });
  });

  it("still works before the timestamp expires", async () => {
    const { token } = await createShare(
      db,
      blobs,
      textInput({ ttlSeconds: MIN_TTL_SECONDS }),
    );
    const got = await openShare(token);
    expect(got.content.toString()).toBe("top secret");
  });

  it("rejects an out-of-range max_accesses with 400", async () => {
    await expect(
      createShare(db, blobs, textInput({ maxAccesses: 101 })),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("preserves filename and mime for file shares", async () => {
    const { token } = await createShare(db, blobs, {
      kind: "file",
      content: Buffer.from([1, 2, 3, 4]),
      mime: "image/png",
      filename: "pic.png",
      ttlSeconds: DEFAULT_TTL_SECONDS,
      maxAccesses: 1,
    });
    const got = await openShare(token);
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
    expect(shareStatus(db, token)).toEqual({ available: true, passwordProtected: false, lockedUntil: null });
    expect(shareStatus(db, token)).toEqual({ available: true, passwordProtected: false, lockedUntil: null });
    expect(db.prepare("SELECT access_count FROM shares").get()).toEqual({ access_count: 0 });
    const got = await openShare(token);
    expect(got.content.toString()).toBe("top secret");
  });

  it("reports an unknown or already used single-use token as 404", async () => {
    expect(shareStatus(db, "nonexistent-token")).toEqual({ available: false, status: 404 });
    const { token } = await createShare(db, blobs, textInput({ maxAccesses: 1 }));
    await consumeShare(db, blobs, token);
    expect(shareStatus(db, token)).toEqual({ available: false, status: 404 });
  });

  it("reports an expired share as 410 without purging it", async () => {
    const { token } = await createShare(db, blobs, textInput());
    expireAllShares();
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
    ttlSeconds: DEFAULT_TTL_SECONDS,
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
    const got = await openShare(token);
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

    const got = await openShare(token);
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

describe("share option limits", () => {
  it("accepts 1 and 100 views and rejects 0, 101 and fractions", async () => {
    await expect(createShare(db, blobs, textInput({ maxAccesses: 1 }))).resolves.toBeDefined();
    await expect(createShare(db, blobs, textInput({ maxAccesses: 100 }))).resolves.toBeDefined();
    await expect(createShare(db, blobs, textInput({ maxAccesses: 0 }))).rejects.toMatchObject({
      status: 400,
      code: "BAD_MAX_ACCESSES",
    });
    await expect(createShare(db, blobs, textInput({ maxAccesses: 101 }))).rejects.toMatchObject({ status: 400 });
    await expect(createShare(db, blobs, textInput({ maxAccesses: 2.5 }))).rejects.toMatchObject({ status: 400 });
  });

  it("accepts a lifetime from 1 hour to 365 days and rejects anything outside", async () => {
    await expect(createShare(db, blobs, textInput({ ttlSeconds: MIN_TTL_SECONDS }))).resolves.toBeDefined();
    await expect(createShare(db, blobs, textInput({ ttlSeconds: MAX_TTL_SECONDS }))).resolves.toBeDefined();
    await expect(createShare(db, blobs, textInput({ ttlSeconds: MIN_TTL_SECONDS - 1 }))).rejects.toMatchObject({
      status: 400,
      code: "BAD_TTL",
    });
    await expect(createShare(db, blobs, textInput({ ttlSeconds: MAX_TTL_SECONDS + 1 }))).rejects.toMatchObject({
      status: 400,
    });
    expect(db.prepare("SELECT COUNT(*) c FROM shares").get()).toEqual({ c: 2 });
  });

  it("computes the expiry from the server clock", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_800_000_000_000);
    try {
      await createShare(db, blobs, textInput({ ttlSeconds: 7200 }));
      expect(db.prepare("SELECT expires_at FROM shares").get()).toEqual({ expires_at: 1_800_000_000_000 + 7_200_000 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a password shorter than 4 or longer than 128 characters", async () => {
    await expect(createShare(db, blobs, textInput({ password: "abc" }))).rejects.toMatchObject({
      status: 400,
      code: "BAD_PASSWORD",
    });
    await expect(createShare(db, blobs, textInput({ password: "x".repeat(129) }))).rejects.toMatchObject({
      status: 400,
    });
    expect(db.prepare("SELECT COUNT(*) c FROM shares").get()).toEqual({ c: 0 });
  });
});

describe("password protected shares", () => {
  const PASSWORD = "heron-42";
  const START = 1_800_000_000_000;
  const accessCount = () => db.prepare("SELECT access_count FROM shares").get();
  const lockedUntil = () => db.prepare("SELECT locked_until FROM shares").get();

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(START);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stores only a salted hash of the password", async () => {
    await createShare(db, blobs, textInput({ password: PASSWORD }));
    const { password_hash } = db.prepare("SELECT password_hash FROM shares").get() as { password_hash: string };
    expect(password_hash.startsWith("scrypt$")).toBe(true);
    expect(password_hash.includes(PASSWORD)).toBe(false);
  });

  it("reports the share as password protected on the side-effect free status read", async () => {
    const { token } = await createShare(db, blobs, textInput({ password: PASSWORD }));
    expect(shareStatus(db, token)).toEqual({ available: true, passwordProtected: true, lockedUntil: null });
  });

  it("asks for the password without locking or consuming a view when none is given", async () => {
    const { token } = await createShare(db, blobs, textInput({ password: PASSWORD }));
    await expect(consumeShare(db, blobs, token)).resolves.toEqual({ status: "password-required" });
    expect(accessCount()).toEqual({ access_count: 0 });
    expect(lockedUntil()).toEqual({ locked_until: null });
  });

  it("locks the share for 5 minutes after a wrong password without consuming a view", async () => {
    const { token } = await createShare(db, blobs, textInput({ password: PASSWORD }));
    await expect(consumeShare(db, blobs, token, "wrong")).resolves.toEqual({
      status: "wrong-password",
      retryAfterMs: LOCK_DURATION_MS,
    });
    expect(accessCount()).toEqual({ access_count: 0 });
    expect(lockedUntil()).toEqual({ locked_until: START + LOCK_DURATION_MS });
    expect(shareStatus(db, token)).toEqual({
      available: true,
      passwordProtected: true,
      lockedUntil: START + LOCK_DURATION_MS,
    });
  });

  it("refuses even the correct password while locked, reporting the time left", async () => {
    const { token } = await createShare(db, blobs, textInput({ password: PASSWORD }));
    await consumeShare(db, blobs, token, "wrong");
    vi.setSystemTime(START + 60_000);
    await expect(consumeShare(db, blobs, token, PASSWORD)).resolves.toEqual({
      status: "locked",
      retryAfterMs: LOCK_DURATION_MS - 60_000,
    });
    expect(accessCount()).toEqual({ access_count: 0 });
    expect(lockedUntil()).toEqual({ locked_until: START + LOCK_DURATION_MS });
  });

  it("opens with the correct password once the lock has ended, consuming one view", async () => {
    const { token } = await createShare(db, blobs, textInput({ password: PASSWORD, maxAccesses: 2 }));
    await consumeShare(db, blobs, token, "wrong");
    vi.setSystemTime(START + LOCK_DURATION_MS + 1);
    expect(shareStatus(db, token)).toMatchObject({ available: true, lockedUntil: null });
    const share = await openShare(token, PASSWORD);
    expect(share.content.toString()).toBe("top secret");
    expect(accessCount()).toEqual({ access_count: 1 });
    expect(db.prepare("SELECT expires_at, max_accesses FROM shares").get()).toEqual({
      expires_at: START + DEFAULT_TTL_SECONDS * 1000,
      max_accesses: 2,
    });
  });

  it("leaves shares without a password unaffected by a password argument", async () => {
    const { token } = await createShare(db, blobs, textInput());
    const share = await openShare(token, "anything");
    expect(share.content.toString()).toBe("top secret");
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
