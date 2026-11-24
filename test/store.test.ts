import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { openDb, type DB } from "../lib/db";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { E2E_V1_PAYLOAD_FORMAT, LEGACY_PAYLOAD_FORMAT, SEALED_PAYLOAD_FORMAT } from "../lib/db";
import { deriveKey, encrypt, generateToken, hashToken } from "../lib/crypto";
import {
  assertValidE2eInput,
  consumeE2eShare,
  createE2eShare,
  createShare,
  consumeShare,
  revokeShare,
  shareStatus,
  ShareError,
  type CreateE2eInput,
} from "../lib/store";
import { purgeExpired } from "../lib/cleanup";
import {
  E2E_KDF_ITERATIONS,
  decryptText,
  deriveRevealProofs,
  encryptText,
  fromBase64Url,
  type E2eTextUpload,
  type RevealProofs,
} from "../lib/e2e-crypto";
import { MAX_SIZE } from "../lib/file-support";
import type { BlobStore } from "../lib/blob-store";
import {
  DEFAULT_TTL_SECONDS,
  LOCK_DURATION_MS,
  MAX_TTL_SECONDS,
  MIN_TTL_SECONDS,
  SHARE_LOCK_FAILURES,
  VISITOR_LOCK_FAILURES,
} from "../lib/share-options";

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
    expect(shareStatus(db, token)).toEqual({ available: true, format: "legacy", passwordProtected: false, lockedUntil: null });
    expect(shareStatus(db, token)).toEqual({ available: true, format: "legacy", passwordProtected: false, lockedUntil: null });
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
    const { token, revokeToken } = await createShare(db, blobs, textInput());
    blobs.delete = () => {
      throw new Error("io error");
    };
    expect(() => revokeShare(db, blobs, token, revokeToken)).toThrow("io error");
    expect(shareStatus(db, token)).toEqual({ available: false, status: 404 });
  });
});

describe("revoke token", () => {
  it("returns a revoke token different from the link token and stores only its hash", async () => {
    const { token, revokeToken } = await createShare(db, blobs, textInput());
    expect(revokeToken).not.toBe(token);
    const row = db.prepare("SELECT revoke_token_hash FROM shares").get() as { revoke_token_hash: string };
    expect(row.revoke_token_hash).toBe(hashToken(revokeToken));
    expect(row.revoke_token_hash).not.toContain(revokeToken);
  });

  it("revokes with the matching revoke token", async () => {
    const { token, revokeToken } = await createShare(db, blobs, textInput());
    expect(revokeShare(db, blobs, token, revokeToken)).toBe(true);
    expect(shareStatus(db, token)).toEqual({ available: false, status: 404 });
    expect(blobs.map.size).toBe(0);
  });

  it("refuses the link token, a missing token and a wrong token, keeping the share", async () => {
    const { token } = await createShare(db, blobs, textInput());
    expect(revokeShare(db, blobs, token)).toBe(false);
    expect(revokeShare(db, blobs, token, token)).toBe(false);
    expect(revokeShare(db, blobs, token, generateToken())).toBe(false);
    expect(revokeShare(db, blobs, token, "")).toBe(false);
    expect((await openShare(token)).content.toString()).toBe("top secret");
  });

  it("answers an unknown share exactly like a refused revoke", async () => {
    const { token } = await createShare(db, blobs, textInput());
    expect(revokeShare(db, blobs, generateToken(), generateToken())).toBe(
      revokeShare(db, blobs, token, generateToken()),
    );
  });

  it("keeps the old behaviour for a legacy share without a revoke token hash", async () => {
    const { token } = await createShare(db, blobs, textInput());
    db.prepare("UPDATE shares SET revoke_token_hash = NULL").run();
    expect(revokeShare(db, blobs, token)).toBe(true);
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

  it("rejects a password shorter than 8 or longer than 128 characters", async () => {
    await expect(createShare(db, blobs, textInput({ password: "seven-7" }))).rejects.toMatchObject({
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
    expect(shareStatus(db, token)).toEqual({ available: true, format: "legacy", passwordProtected: true, lockedUntil: null });
  });

  it("asks for the password without locking or consuming a view when none is given", async () => {
    const { token } = await createShare(db, blobs, textInput({ password: PASSWORD }));
    await expect(consumeShare(db, blobs, token)).resolves.toEqual({ status: "password-required" });
    expect(accessCount()).toEqual({ access_count: 0 });
    expect(lockedUntil()).toEqual({ locked_until: null });
  });

  async function guessWrong(token: string, times: number, visitorPrefix: string) {
    let outcome: Awaited<ReturnType<typeof consumeShare>> | undefined;
    for (let guess = 0; guess < times; guess++) {
      outcome = await consumeShare(db, blobs, token, "wrong", `${visitorPrefix}-${guess}`);
    }
    return outcome;
  }

  it("does not lock the share for other visitors after a wrong password, and consumes no view", async () => {
    const { token } = await createShare(db, blobs, textInput({ password: PASSWORD }));
    await expect(consumeShare(db, blobs, token, "wrong", "visitor-a")).resolves.toEqual({
      status: "wrong-password",
      retryAfterMs: 0,
    });
    expect(accessCount()).toEqual({ access_count: 0 });
    expect(lockedUntil()).toEqual({ locked_until: null });
    expect(shareStatus(db, token)).toEqual({ available: true, format: "legacy", passwordProtected: true, lockedUntil: null });
    expect((await openShare(token, PASSWORD)).content.toString()).toBe("top secret");
  });

  it("locks only the guessing visitor for 5 minutes after 3 wrong passwords", async () => {
    const { token } = await createShare(db, blobs, textInput({ password: PASSWORD, maxAccesses: 3 }));
    for (let guess = 1; guess < VISITOR_LOCK_FAILURES; guess++) {
      await expect(consumeShare(db, blobs, token, "wrong", "visitor-a")).resolves.toEqual({
        status: "wrong-password",
        retryAfterMs: 0,
      });
    }
    await expect(consumeShare(db, blobs, token, "wrong", "visitor-a")).resolves.toEqual({
      status: "wrong-password",
      retryAfterMs: LOCK_DURATION_MS,
    });
    vi.setSystemTime(START + 60_000);
    await expect(consumeShare(db, blobs, token, PASSWORD, "visitor-a")).resolves.toEqual({
      status: "locked",
      retryAfterMs: LOCK_DURATION_MS - 60_000,
    });
    expect(accessCount()).toEqual({ access_count: 0 });
    expect(lockedUntil()).toEqual({ locked_until: null });
    expect(shareStatus(db, token)).toMatchObject({ available: true, lockedUntil: null });
    expect((await openShare(token, PASSWORD)).content.toString()).toBe("top secret");

    vi.setSystemTime(START + LOCK_DURATION_MS);
    await expect(consumeShare(db, blobs, token, PASSWORD, "visitor-a")).resolves.toMatchObject({ status: "opened" });
    expect(accessCount()).toEqual({ access_count: 2 });
  });

  it("locks the share for everyone after 10 wrong passwords, doubling the lock each time", async () => {
    const { token } = await createShare(db, blobs, textInput({ password: PASSWORD, maxAccesses: 2 }));
    await expect(guessWrong(token, SHARE_LOCK_FAILURES - 1, "first")).resolves.toEqual({
      status: "wrong-password",
      retryAfterMs: 0,
    });
    expect(lockedUntil()).toEqual({ locked_until: null });
    await expect(consumeShare(db, blobs, token, "wrong", "first-last")).resolves.toEqual({
      status: "wrong-password",
      retryAfterMs: LOCK_DURATION_MS,
    });
    expect(lockedUntil()).toEqual({ locked_until: START + LOCK_DURATION_MS });
    expect(shareStatus(db, token)).toEqual({
      available: true,
      format: "legacy",
      passwordProtected: true,
      lockedUntil: START + LOCK_DURATION_MS,
    });

    vi.setSystemTime(START + 60_000);
    await expect(consumeShare(db, blobs, token, PASSWORD, "newcomer")).resolves.toEqual({
      status: "locked",
      retryAfterMs: LOCK_DURATION_MS - 60_000,
    });
    expect(accessCount()).toEqual({ access_count: 0 });

    const secondRound = START + LOCK_DURATION_MS;
    vi.setSystemTime(secondRound);
    expect((await openShare(token, PASSWORD)).content.toString()).toBe("top secret");
    expect(accessCount()).toEqual({ access_count: 1 });
    expect(db.prepare("SELECT expires_at, max_accesses FROM shares").get()).toEqual({
      expires_at: START + DEFAULT_TTL_SECONDS * 1000,
      max_accesses: 2,
    });
    await expect(guessWrong(token, SHARE_LOCK_FAILURES, "second")).resolves.toEqual({
      status: "wrong-password",
      retryAfterMs: 2 * LOCK_DURATION_MS,
    });
    expect(lockedUntil()).toEqual({ locked_until: secondRound + 2 * LOCK_DURATION_MS });
  });

  it("keeps counting wrong passwords however far apart they are", async () => {
    const { token } = await createShare(db, blobs, textInput({ password: PASSWORD, ttlSeconds: MAX_TTL_SECONDS }));
    for (let guess = 1; guess < SHARE_LOCK_FAILURES; guess++) {
      vi.setSystemTime(START + guess * 24 * 60 * 60 * 1000);
      await consumeShare(db, blobs, token, "wrong", `spaced-${guess}`);
    }
    expect(lockedUntil()).toEqual({ locked_until: null });
    await expect(consumeShare(db, blobs, token, "wrong", "spaced-last")).resolves.toEqual({
      status: "wrong-password",
      retryAfterMs: LOCK_DURATION_MS,
    });
  });

  it("clears the visitor's failures after a correct password and does not count it as a failure", async () => {
    const { token } = await createShare(db, blobs, textInput({ password: PASSWORD, maxAccesses: 2 }));
    await consumeShare(db, blobs, token, "wrong", "visitor-a");
    await consumeShare(db, blobs, token, "wrong", "visitor-a");
    await expect(consumeShare(db, blobs, token, PASSWORD, "visitor-a")).resolves.toMatchObject({ status: "opened" });
    await expect(consumeShare(db, blobs, token, "wrong", "visitor-a")).resolves.toEqual({
      status: "wrong-password",
      retryAfterMs: 0,
    });
    expect(db.prepare("SELECT failed_attempts, locked_until FROM shares").get()).toEqual({
      failed_attempts: 3,
      locked_until: null,
    });
  });

  it("reports locked without checking the password when another attempt claimed the lock first", async () => {
    const { token } = await createShare(db, blobs, textInput({ password: PASSWORD }));
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
      const statement = prepare(sql);
      if (!sql.startsWith("SELECT * FROM shares")) return statement;
      return {
        get: (...parameters: unknown[]) => {
          const row = statement.get(...parameters);
          prepare("UPDATE shares SET locked_until = ?").run(START + 1000);
          return row;
        },
      };
    }) as typeof db.prepare);
    await expect(consumeShare(db, blobs, token, PASSWORD)).resolves.toEqual({ status: "locked", retryAfterMs: 1000 });
    expect(accessCount()).toEqual({ access_count: 0 });
    expect(lockedUntil()).toEqual({ locked_until: START + 1000 });
  });

  it("leaves shares without a password unaffected by a password argument", async () => {
    const { token } = await createShare(db, blobs, textInput());
    const share = await openShare(token, "anything");
    expect(share.content.toString()).toBe("top secret");
  });
});

describe("e2e shares", () => {
  const PLAINTEXT = "end to end secret";
  const PASSWORD = "heron-42";
  const START = 1_800_000_000_000;
  let plainUpload: E2eTextUpload;
  let plainProofs: RevealProofs;
  let passwordUpload: E2eTextUpload;
  let passwordProofs: RevealProofs;
  let otherProofs: RevealProofs;

  beforeAll(async () => {
    plainUpload = await encryptText(PLAINTEXT);
    plainProofs = await deriveRevealProofs(plainUpload.fragmentKey, plainUpload.salt, plainUpload.kdfIterations, "");
    passwordUpload = await encryptText(PLAINTEXT, PASSWORD);
    passwordProofs = await deriveRevealProofs(
      passwordUpload.fragmentKey,
      passwordUpload.salt,
      passwordUpload.kdfIterations,
      PASSWORD,
    );
    const otherUpload = await encryptText("another secret");
    otherProofs = await deriveRevealProofs(otherUpload.fragmentKey, otherUpload.salt, otherUpload.kdfIterations, "");
  }, 60_000);

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(START);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const e2eInput = (upload: E2eTextUpload, over: Partial<CreateE2eInput> = {}): CreateE2eInput => ({
    ciphertext: Buffer.from(upload.ciphertext),
    iv: Buffer.from(fromBase64Url(upload.iv)),
    salt: Buffer.from(fromBase64Url(upload.salt)),
    kdfIterations: upload.kdfIterations,
    linkProofHash: upload.linkProofHash,
    authHash: upload.authHash,
    maxAccesses: 1,
    ttlSeconds: DEFAULT_TTL_SECONDS,
    ...over,
  });

  const proofBytes = (proof: string) => Buffer.from(proof, "base64url");
  const WRONG_AUTH_KEY = Buffer.alloc(32, 7);
  const counters = () => db.prepare("SELECT access_count, failed_attempts, locked_until, lockouts FROM shares").get();
  const shareCount = () => db.prepare("SELECT COUNT(*) c FROM shares").get();

  function errorOf(action: () => unknown): unknown {
    try {
      action();
    } catch (error) {
      return error;
    }
    throw new Error("expected the action to throw");
  }

  it("stores the client ciphertext byte for byte and no plaintext anywhere", () => {
    const { linkId } = createE2eShare(db, blobs, e2eInput(plainUpload));
    expect(linkId).toHaveLength(22);
    const row = db.prepare("SELECT * FROM shares").get() as Record<string, unknown>;
    expect(row).toMatchObject({
      token_hash: hashToken(linkId),
      kind: "text",
      payload_format: E2E_V1_PAYLOAD_FORMAT,
      filename: null,
      mime: null,
      password_hash: null,
      e2e_kdf_iterations: 0,
      link_proof_hash: plainUpload.linkProofHash,
      auth_hash: null,
    });
    expect(row.auth_tag).toEqual(Buffer.alloc(0));
    expect(row.iv).toEqual(Buffer.from(fromBase64Url(plainUpload.iv)));
    expect(row.e2e_salt).toEqual(Buffer.from(fromBase64Url(plainUpload.salt)));
    expect(blobs.map.get(row.blob_path as string)).toEqual(Buffer.from(plainUpload.ciphertext));
    const containsPlaintext = (value: unknown) =>
      Buffer.isBuffer(value) ? value.includes(PLAINTEXT) : String(value).includes(PLAINTEXT);
    expect([...Object.values(row), ...blobs.map.values()].some(containsPlaintext)).toBe(false);
  });

  it("reports the format, salt and iterations on the status read", async () => {
    const { linkId: plainLinkId } = createE2eShare(db, blobs, e2eInput(plainUpload));
    const { linkId: passwordLinkId } = createE2eShare(db, blobs, e2eInput(passwordUpload));
    const { token: legacyToken } = await createShare(db, blobs, textInput());
    expect(shareStatus(db, plainLinkId)).toEqual({
      available: true,
      format: "e2e-v1",
      salt: plainUpload.salt,
      kdfIterations: 0,
      passwordProtected: false,
      lockedUntil: null,
    });
    expect(shareStatus(db, passwordLinkId)).toEqual({
      available: true,
      format: "e2e-v1",
      salt: passwordUpload.salt,
      kdfIterations: E2E_KDF_ITERATIONS,
      passwordProtected: true,
      lockedUntil: null,
    });
    expect(shareStatus(db, legacyToken)).toMatchObject({ available: true, format: "legacy" });
  });

  it("opens with the right link proof, returns the stored ciphertext and purges after the last view", async () => {
    const { linkId } = createE2eShare(db, blobs, e2eInput(plainUpload));
    const outcome = consumeE2eShare(db, blobs, linkId, proofBytes(plainProofs.linkProof), null);
    if (outcome.status !== "opened") throw new Error(`share not opened: ${outcome.status}`);
    expect(outcome.ciphertext).toEqual(Buffer.from(plainUpload.ciphertext));
    expect(outcome.iv).toEqual(Buffer.from(fromBase64Url(plainUpload.iv)));
    await expect(
      decryptText(plainProofs.encKey, outcome.ciphertext.toString("base64url"), outcome.iv.toString("base64url")),
    ).resolves.toBe(PLAINTEXT);
    expect(errorOf(() => consumeE2eShare(db, blobs, linkId, proofBytes(plainProofs.linkProof), null))).toMatchObject({
      status: 404,
    });
    expect(shareCount()).toEqual({ c: 0 });
    expect(blobs.map.size).toBe(0);
  });

  it("returns 410 and purges an expired share", () => {
    const { linkId } = createE2eShare(db, blobs, e2eInput(plainUpload));
    expireAllShares();
    expect(errorOf(() => consumeE2eShare(db, blobs, linkId, proofBytes(plainProofs.linkProof), null))).toMatchObject({
      status: 410,
    });
    expect(shareCount()).toEqual({ c: 0 });
  });

  it("answers a wrong link proof like a missing share, touching no counter or lock", () => {
    const { linkId } = createE2eShare(db, blobs, e2eInput(plainUpload, { maxAccesses: 2 }));
    const missing = errorOf(() => consumeE2eShare(db, blobs, "missing-link", proofBytes(plainProofs.linkProof), null));
    const wrongProof = errorOf(() => consumeE2eShare(db, blobs, linkId, proofBytes(otherProofs.linkProof), null));
    expect(wrongProof).toBeInstanceOf(ShareError);
    expect(wrongProof).toEqual(missing);
    expect(wrongProof).toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(counters()).toEqual({ access_count: 0, failed_attempts: 0, locked_until: null, lockouts: 0 });
  });

  it("ignores a wrong authKey sent with a wrong link proof, without locking the visitor", () => {
    const { linkId } = createE2eShare(db, blobs, e2eInput(passwordUpload, { maxAccesses: 2 }));
    for (let attempt = 0; attempt < SHARE_LOCK_FAILURES; attempt++) {
      expect(
        errorOf(() => consumeE2eShare(db, blobs, linkId, proofBytes(otherProofs.linkProof), WRONG_AUTH_KEY, "visitor-a")),
      ).toMatchObject({ status: 404 });
    }
    expect(counters()).toEqual({ access_count: 0, failed_attempts: 0, locked_until: null, lockouts: 0 });
    expect(
      consumeE2eShare(
        db,
        blobs,
        linkId,
        proofBytes(passwordProofs.linkProof),
        proofBytes(passwordProofs.authKey),
        "visitor-a",
      ),
    ).toMatchObject({ status: "opened" });
  });

  it("asks for the password without consuming a view when no authKey is given", () => {
    const { linkId } = createE2eShare(db, blobs, e2eInput(passwordUpload));
    expect(consumeE2eShare(db, blobs, linkId, proofBytes(passwordProofs.linkProof), null)).toEqual({
      status: "password-required",
    });
    expect(counters()).toEqual({ access_count: 0, failed_attempts: 0, locked_until: null, lockouts: 0 });
  });

  it("locks only the guessing visitor after 3 wrong authKeys, and consumes no view", () => {
    const { linkId } = createE2eShare(db, blobs, e2eInput(passwordUpload));
    const linkProof = proofBytes(passwordProofs.linkProof);
    for (let guess = 1; guess < VISITOR_LOCK_FAILURES; guess++) {
      expect(consumeE2eShare(db, blobs, linkId, linkProof, WRONG_AUTH_KEY, "visitor-a")).toEqual({
        status: "wrong-password",
        retryAfterMs: 0,
      });
    }
    expect(consumeE2eShare(db, blobs, linkId, linkProof, WRONG_AUTH_KEY, "visitor-a")).toEqual({
      status: "wrong-password",
      retryAfterMs: LOCK_DURATION_MS,
    });
    expect(consumeE2eShare(db, blobs, linkId, linkProof, proofBytes(passwordProofs.authKey), "visitor-a")).toEqual({
      status: "locked",
      retryAfterMs: LOCK_DURATION_MS,
    });
    expect(counters()).toMatchObject({ access_count: 0, locked_until: null });
    expect(
      consumeE2eShare(db, blobs, linkId, linkProof, proofBytes(passwordProofs.authKey), "visitor-b"),
    ).toMatchObject({ status: "opened" });
  });

  it("locks the share for everyone after 10 wrong authKeys", () => {
    const { linkId } = createE2eShare(db, blobs, e2eInput(passwordUpload));
    const linkProof = proofBytes(passwordProofs.linkProof);
    for (let guess = 1; guess < SHARE_LOCK_FAILURES; guess++) {
      expect(consumeE2eShare(db, blobs, linkId, linkProof, WRONG_AUTH_KEY, `visitor-${guess}`)).toEqual({
        status: "wrong-password",
        retryAfterMs: 0,
      });
    }
    expect(consumeE2eShare(db, blobs, linkId, linkProof, WRONG_AUTH_KEY, "visitor-last")).toEqual({
      status: "wrong-password",
      retryAfterMs: LOCK_DURATION_MS,
    });
    expect(counters()).toEqual({
      access_count: 0,
      failed_attempts: 0,
      locked_until: START + LOCK_DURATION_MS,
      lockouts: 1,
    });
    expect(consumeE2eShare(db, blobs, linkId, linkProof, proofBytes(passwordProofs.authKey), "newcomer")).toEqual({
      status: "locked",
      retryAfterMs: LOCK_DURATION_MS,
    });
  });

  it("opens with the right authKey after a failure and clears the visitor lock", () => {
    const { linkId } = createE2eShare(db, blobs, e2eInput(passwordUpload, { maxAccesses: 2 }));
    const linkProof = proofBytes(passwordProofs.linkProof);
    const guessWrong = () => consumeE2eShare(db, blobs, linkId, linkProof, WRONG_AUTH_KEY, "visitor-a");
    expect(guessWrong()).toEqual({ status: "wrong-password", retryAfterMs: 0 });
    expect(guessWrong()).toEqual({ status: "wrong-password", retryAfterMs: 0 });
    expect(
      consumeE2eShare(db, blobs, linkId, linkProof, proofBytes(passwordProofs.authKey), "visitor-a"),
    ).toMatchObject({ status: "opened", ciphertext: Buffer.from(passwordUpload.ciphertext) });
    expect(guessWrong()).toEqual({ status: "wrong-password", retryAfterMs: 0 });
    expect(guessWrong()).toEqual({ status: "wrong-password", retryAfterMs: 0 });
    expect(counters()).toMatchObject({ access_count: 1 });
  });

  it("keeps the legacy and E2E consume paths apart without counting a view", async () => {
    const { linkId } = createE2eShare(db, blobs, e2eInput(plainUpload));
    await expect(consumeShare(db, blobs, linkId)).rejects.toMatchObject({ status: 404 });
    expect(counters()).toMatchObject({ access_count: 0 });

    db.prepare("DELETE FROM shares").run();
    const { token } = await createShare(db, blobs, textInput());
    expect(errorOf(() => consumeE2eShare(db, blobs, token, proofBytes(plainProofs.linkProof), null))).toMatchObject({
      status: 404,
    });
    expect(counters()).toMatchObject({ access_count: 0 });
  });

  const malformedInputs: [string, () => CreateE2eInput][] = [
    ["an iv of 11 bytes", () => e2eInput(plainUpload, { iv: Buffer.alloc(11) })],
    ["a salt of 15 bytes", () => e2eInput(plainUpload, { salt: Buffer.alloc(15) })],
    ["a link proof hash of 63 chars", () => e2eInput(plainUpload, { linkProofHash: "a".repeat(63) })],
    ["1000 kdf iterations", () => e2eInput(passwordUpload, { kdfIterations: 1000 })],
    ["an auth hash without kdf iterations", () => e2eInput(plainUpload, { authHash: "a".repeat(64) })],
    ["kdf iterations without an auth hash", () => e2eInput(passwordUpload, { authHash: null })],
    ["a ciphertext of 19 bytes", () => e2eInput(plainUpload, { ciphertext: Buffer.alloc(19) })],
    ["a ciphertext over the size cap", () => e2eInput(plainUpload, { ciphertext: Buffer.alloc(MAX_SIZE + 1025) })],
  ];

  it.each(malformedInputs)("rejects %s without writing a row", (_, buildInput) => {
    const input = buildInput();
    expect(errorOf(() => assertValidE2eInput(input))).toMatchObject({ status: 400, code: "BAD_E2E_PAYLOAD" });
    expect(errorOf(() => createE2eShare(db, blobs, input))).toMatchObject({ status: 400, code: "BAD_E2E_PAYLOAD" });
    expect(shareCount()).toEqual({ c: 0 });
    expect(blobs.map.size).toBe(0);
  });

  it("accepts a ciphertext at the size cap and validates the share options", () => {
    expect(() =>
      assertValidE2eInput(e2eInput(plainUpload, { ciphertext: Buffer.alloc(MAX_SIZE + 1024) })),
    ).not.toThrow();
    expect(errorOf(() => createE2eShare(db, blobs, e2eInput(plainUpload, { maxAccesses: 0 })))).toMatchObject({
      status: 400,
      code: "BAD_MAX_ACCESSES",
    });
  });

  it("is found by revoke and by the expiry cleanup", () => {
    const { linkId, revokeToken } = createE2eShare(db, blobs, e2eInput(plainUpload));
    expect(revokeShare(db, blobs, linkId, revokeToken)).toBe(true);
    expect(shareCount()).toEqual({ c: 0 });
    expect(blobs.map.size).toBe(0);

    createE2eShare(db, blobs, e2eInput(plainUpload));
    expireAllShares();
    expect(purgeExpired(db, blobs)).toBe(1);
    expect(shareCount()).toEqual({ c: 0 });
    expect(blobs.map.size).toBe(0);
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
    const { token, revokeToken } = await createShare(fileDb, blobs, textInput());
    const tokenHash = hashToken(token);
    const databaseBytes = () =>
      Buffer.concat([readFileSync(join(tempDir, "share.db")), readFileSync(join(tempDir, "share.db-wal"))]);
    expect(databaseBytes().includes(tokenHash)).toBe(true);

    revokeShare(fileDb, blobs, token, revokeToken);

    expect(statSync(join(tempDir, "share.db-wal")).size).toBe(0);
    expect(databaseBytes().includes(tokenHash)).toBe(false);
  });
});
