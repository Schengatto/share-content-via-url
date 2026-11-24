import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  E2E_V1_PAYLOAD_FORMAT,
  LEGACY_PAYLOAD_FORMAT,
  SEALED_PAYLOAD_FORMAT,
  scrubDeletedData,
  type DB,
} from "./db";
import type { BlobStore } from "./blob-store";
import {
  generateToken,
  hashToken,
  hashesMatch,
  deriveKey,
  derivePasswordBoundKey,
  encrypt,
  decrypt,
  PASSWORD_KEY_SALT_BYTES,
} from "./crypto";
import { E2E_IV_BYTES, E2E_KDF_ITERATIONS, E2E_MIN_CIPHERTEXT_BYTES, E2E_SALT_BYTES } from "./e2e-crypto";
import { MAX_SIZE } from "./file-support";
import { openPayload, sealPayload } from "./sealed-payload";
import { hashPassword, verifyPassword } from "./password";
import {
  MAX_PASSWORD_LENGTH,
  MAX_TTL_SECONDS,
  MAX_VIEWS,
  MIN_PASSWORD_LENGTH,
  MIN_TTL_SECONDS,
  MIN_VIEWS,
  SHARE_LOCK_FAILURES,
  isValidPassword,
  isValidTtlSeconds,
  isValidViews,
  shareLockDurationMs,
} from "./share-options";
import { visitorPasswordLock } from "./visitor-lock";

export class ShareError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
  ) {
    super(message);
    this.name = "ShareError";
  }
}

export interface ShareOptions {
  maxAccesses: number;
  ttlSeconds: number;
  password?: string;
}

export interface CreateInput extends ShareOptions {
  kind: "text" | "file";
  content: Buffer;
  mime: string;
  filename?: string;
}

export interface CreateResult {
  token: string;
  revokeToken: string;
  id: string;
}

export interface ConsumeResult {
  kind: "text" | "file";
  mime: string;
  filename: string | null;
  content: Buffer;
}

export type ConsumeOutcome =
  | { status: "opened"; share: ConsumeResult }
  | { status: "password-required" }
  | { status: "wrong-password"; retryAfterMs: number }
  | { status: "locked"; retryAfterMs: number };

type BlockedOutcome = Exclude<ConsumeOutcome, { status: "opened" }>;

export type E2eConsumeOutcome = { status: "opened"; ciphertext: Buffer; iv: Buffer } | BlockedOutcome;

export interface CreateE2eInput {
  ciphertext: Buffer;
  iv: Buffer;
  salt: Buffer;
  kdfIterations: number;
  linkProofHash: string;
  authHash: string | null;
  maxAccesses: number;
  ttlSeconds: number;
}

export interface CreateE2eResult {
  linkId: string;
  revokeToken: string;
}

const LINK_ID_BYTES = 16;
const E2E_CIPHERTEXT_OVERHEAD_BYTES = 1024;
const SHA256_HEX = /^[0-9a-f]{64}$/;

interface ShareRow {
  id: string;
  token_hash: string;
  kind: "text" | "file";
  payload_format: number;
  filename: string | null;
  mime: string | null;
  blob_path: string;
  iv: Buffer;
  auth_tag: Buffer;
  expires_at: number | null;
  max_accesses: number | null;
  access_count: number;
  created_at: number;
  password_hash: string | null;
  locked_until: number | null;
  revoke_token_hash: string | null;
  failed_attempts: number;
  lockouts: number;
  e2e_salt: Buffer | null;
  e2e_kdf_iterations: number | null;
  link_proof_hash: string | null;
  auth_hash: string | null;
  password_key_salt: Buffer | null;
}

type ShareFormat = { format: "legacy" } | { format: "e2e-v1"; salt: string; kdfIterations: number };

export type ShareStatus =
  | ({ available: true; passwordProtected: boolean; lockedUntil: number | null } & ShareFormat)
  | { available: false; status: 404 | 410 };

type UsageFields = Pick<ShareRow, "expires_at" | "max_accesses" | "access_count">;

function isUsedUp(row: UsageFields, now: number): boolean {
  return (
    (row.expires_at !== null && now > row.expires_at) ||
    (row.max_accesses !== null && row.access_count >= row.max_accesses)
  );
}

function activeLockUntil(row: Pick<ShareRow, "locked_until">, now: number): number | null {
  return row.locked_until !== null && row.locked_until > now ? row.locked_until : null;
}

export function shareStatus(db: DB, token: string): ShareStatus {
  const row = db
    .prepare(
      `SELECT expires_at, max_accesses, access_count, password_hash, locked_until,
              payload_format, e2e_salt, e2e_kdf_iterations, auth_hash
       FROM shares WHERE token_hash = ?`,
    )
    .get(hashToken(token)) as
    | (UsageFields &
        Pick<
          ShareRow,
          "password_hash" | "locked_until" | "payload_format" | "e2e_salt" | "e2e_kdf_iterations" | "auth_hash"
        >)
    | undefined;
  if (!row) return { available: false, status: 404 };
  const now = Date.now();
  if (isUsedUp(row, now)) return { available: false, status: 410 };
  const availability = {
    available: true as const,
    passwordProtected: row.password_hash !== null || row.auth_hash !== null,
    lockedUntil: activeLockUntil(row, now),
  };
  if (row.payload_format !== E2E_V1_PAYLOAD_FORMAT || row.e2e_salt === null || row.e2e_kdf_iterations === null) {
    return { ...availability, format: "legacy" };
  }
  return {
    ...availability,
    format: "e2e-v1",
    salt: row.e2e_salt.toString("base64url"),
    kdfIterations: row.e2e_kdf_iterations,
  };
}

export function assertValidShareOptions({ maxAccesses, ttlSeconds, password }: ShareOptions): void {
  if (!isValidViews(maxAccesses)) {
    throw new ShareError(`maxAccesses must be an integer from ${MIN_VIEWS} to ${MAX_VIEWS}`, 400, "BAD_MAX_ACCESSES");
  }
  if (!isValidTtlSeconds(ttlSeconds)) {
    throw new ShareError(
      `ttlSeconds must be an integer from ${MIN_TTL_SECONDS} to ${MAX_TTL_SECONDS}`,
      400,
      "BAD_TTL",
    );
  }
  if (password !== undefined && !isValidPassword(password)) {
    throw new ShareError(
      `Password must be ${MIN_PASSWORD_LENGTH} to ${MAX_PASSWORD_LENGTH} characters`,
      400,
      "BAD_PASSWORD",
    );
  }
}

function purge(db: DB, blobs: BlobStore, row: Pick<ShareRow, "id" | "blob_path">) {
  db.prepare("DELETE FROM shares WHERE id = ?").run(row.id);
  scrubDeletedData(db);
  blobs.delete(row.blob_path);
}

function contentOf(row: ShareRow, plaintext: Buffer): ConsumeResult {
  if (row.payload_format === LEGACY_PAYLOAD_FORMAT) {
    return { kind: row.kind, mime: row.mime ?? "application/octet-stream", filename: row.filename, content: plaintext };
  }
  return { kind: row.kind, ...openPayload(plaintext) };
}

/** Encrypt and persist a new share. Returns the one-time token. */
export async function createShare(
  db: DB,
  blobs: BlobStore,
  input: CreateInput,
): Promise<CreateResult> {
  assertValidShareOptions(input);
  const createdAt = Date.now();
  const passwordHash = input.password === undefined ? null : hashPassword(input.password);

  const token = generateToken();
  const revokeToken = generateToken();
  let passwordKeySalt: Buffer | null = null;
  let key = deriveKey(token);
  if (input.password !== undefined) {
    passwordKeySalt = randomBytes(PASSWORD_KEY_SALT_BYTES);
    key = derivePasswordBoundKey(token, input.password, passwordKeySalt);
  }
  const payload = sealPayload({ filename: input.filename ?? null, mime: input.mime }, input.content);
  const { ciphertext, iv, authTag } = encrypt(payload, key);

  const id = randomUUID();
  const blobPath = id;

  db.transaction(() => {
    db.prepare(
      `INSERT INTO shares
        (id, token_hash, kind, payload_format, blob_path, iv, auth_tag,
         expires_at, max_accesses, access_count, created_at, password_hash, revoke_token_hash, password_key_salt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
    ).run(
      id,
      hashToken(token),
      input.kind,
      SEALED_PAYLOAD_FORMAT,
      blobPath,
      iv,
      authTag,
      createdAt + input.ttlSeconds * 1000,
      input.maxAccesses,
      createdAt,
      passwordHash,
      hashToken(revokeToken),
      passwordKeySalt,
    );
    blobs.put(blobPath, ciphertext);
  })();

  return { token, revokeToken, id };
}

export function assertValidE2eInput(input: CreateE2eInput): void {
  const passwordProtected = input.kdfIterations > 0;
  const wellFormed =
    input.iv.length === E2E_IV_BYTES &&
    input.salt.length === E2E_SALT_BYTES &&
    SHA256_HEX.test(input.linkProofHash) &&
    (input.kdfIterations === 0 || input.kdfIterations === E2E_KDF_ITERATIONS) &&
    (input.authHash === null ? !passwordProtected : passwordProtected && SHA256_HEX.test(input.authHash)) &&
    input.ciphertext.length >= E2E_MIN_CIPHERTEXT_BYTES &&
    input.ciphertext.length <= MAX_SIZE + E2E_CIPHERTEXT_OVERHEAD_BYTES;
  if (!wellFormed) {
    throw new ShareError("Malformed end-to-end encrypted payload", 400, "BAD_E2E_PAYLOAD");
  }
  assertValidShareOptions(input);
}

export function createE2eShare(db: DB, blobs: BlobStore, input: CreateE2eInput): CreateE2eResult {
  assertValidE2eInput(input);
  const createdAt = Date.now();
  const linkId = randomBytes(LINK_ID_BYTES).toString("base64url");
  const revokeToken = generateToken();
  const id = randomUUID();

  db.transaction(() => {
    db.prepare(
      `INSERT INTO shares
        (id, token_hash, kind, payload_format, blob_path, iv, auth_tag,
         expires_at, max_accesses, access_count, created_at, revoke_token_hash,
         e2e_salt, e2e_kdf_iterations, link_proof_hash, auth_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      hashToken(linkId),
      "text",
      E2E_V1_PAYLOAD_FORMAT,
      id,
      input.iv,
      Buffer.alloc(0),
      createdAt + input.ttlSeconds * 1000,
      input.maxAccesses,
      createdAt,
      hashToken(revokeToken),
      input.salt,
      input.kdfIterations,
      input.linkProofHash,
      input.authHash,
    );
    blobs.put(id, input.ciphertext);
  })();

  return { linkId, revokeToken };
}

/**
 * Validate, atomically consume one access, decrypt and return the content.
 * Purges the share when expired/exhausted. Throws ShareError(404|410).
 */
function lockedOutcome(db: DB, id: string, now: number): BlockedOutcome {
  const current = db.prepare("SELECT locked_until FROM shares WHERE id = ?").get(id) as
    | { locked_until: number | null }
    | undefined;
  if (!current) throw new ShareError("Gone", 410, "GONE");
  return { status: "locked", retryAfterMs: Math.max(0, (current.locked_until ?? now) - now) };
}

function wrongPasswordOutcome(db: DB, id: string, visitorKey: string, now: number): BlockedOutcome {
  const visitorLockMs = visitorPasswordLock.recordFailure(visitorKey);
  const failures = db.prepare("SELECT failed_attempts, lockouts FROM shares WHERE id = ?").get(id) as Pick<
    ShareRow,
    "failed_attempts" | "lockouts"
  >;
  if (failures.failed_attempts < SHARE_LOCK_FAILURES) return { status: "wrong-password", retryAfterMs: visitorLockMs };
  const shareLockMs = shareLockDurationMs(failures.lockouts);
  db.prepare(
    "UPDATE shares SET locked_until = ?, lockouts = lockouts + 1, failed_attempts = 0 WHERE id = ?",
  ).run(now + shareLockMs, id);
  return { status: "wrong-password", retryAfterMs: Math.max(shareLockMs, visitorLockMs) };
}

function notFound(): ShareError {
  return new ShareError("Not found", 404, "NOT_FOUND");
}

function findLiveRow(db: DB, blobs: BlobStore, token: string, expectE2e: boolean, now: number): ShareRow {
  const row = db
    .prepare("SELECT * FROM shares WHERE token_hash = ?")
    .get(hashToken(token)) as ShareRow | undefined;

  if (!row || (row.payload_format === E2E_V1_PAYLOAD_FORMAT) !== expectE2e) {
    throw notFound();
  }

  if (isUsedUp(row, now)) {
    purge(db, blobs, row);
    throw new ShareError("Gone", 410, "GONE");
  }
  return row;
}

function shareLockOutcome(row: ShareRow, now: number): BlockedOutcome | null {
  const lockedUntil = activeLockUntil(row, now);
  return lockedUntil === null ? null : { status: "locked", retryAfterMs: lockedUntil - now };
}

function passwordGate(
  db: DB,
  row: ShareRow,
  visitor: string,
  now: number,
  verifyAttempt: (() => boolean) | null,
): BlockedOutcome | null {
  if (verifyAttempt === null) return { status: "password-required" };
  const visitorKey = `${row.id}|${visitor}`;
  const visitorLockMs = visitorPasswordLock.lockedForMs(visitorKey);
  if (visitorLockMs > 0) return { status: "locked", retryAfterMs: visitorLockMs };
  const claim = db
    .prepare(
      "UPDATE shares SET failed_attempts = failed_attempts + 1 WHERE id = ? AND (locked_until IS NULL OR locked_until <= ?)",
    )
    .run(row.id, now);
  if (claim.changes !== 1) return lockedOutcome(db, row.id, now);
  if (!verifyAttempt()) return wrongPasswordOutcome(db, row.id, visitorKey, now);
  db.prepare("UPDATE shares SET failed_attempts = failed_attempts - 1 WHERE id = ?").run(row.id);
  visitorPasswordLock.clear(visitorKey);
  return null;
}

function claimView(db: DB, blobs: BlobStore, row: ShareRow, now: number): number {
  // Atomic, race-safe increment: only succeeds if still valid right now.
  const claimed = db
    .prepare(
      `UPDATE shares SET access_count = access_count + 1
       WHERE id = ?
         AND (max_accesses IS NULL OR access_count < max_accesses)
         AND (expires_at  IS NULL OR expires_at > ?)
       RETURNING access_count`,
    )
    .get(row.id, now) as { access_count: number } | undefined;

  if (claimed === undefined) {
    purge(db, blobs, row);
    throw new ShareError("Gone", 410, "GONE");
  }
  return claimed.access_count;
}

function purgeAfterLastView(db: DB, blobs: BlobStore, row: ShareRow, accessCount: number): void {
  if (row.max_accesses !== null && accessCount >= row.max_accesses) {
    purge(db, blobs, row);
  }
}

function sha256HexOf(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function consumeShare(
  db: DB,
  blobs: BlobStore,
  token: string,
  password = "",
  visitor = "local",
): Promise<ConsumeOutcome> {
  const now = Date.now();
  const row = findLiveRow(db, blobs, token, false, now);

  const lockOutcome = shareLockOutcome(row, now);
  if (lockOutcome) return lockOutcome;

  const passwordHash = row.password_hash;
  if (passwordHash !== null) {
    const gateOutcome = passwordGate(
      db,
      row,
      visitor,
      now,
      password === "" ? null : () => verifyPassword(password, passwordHash),
    );
    if (gateOutcome) return gateOutcome;
  }

  const accessCount = claimView(db, blobs, row, now);

  const key = row.password_key_salt
    ? derivePasswordBoundKey(token, password, row.password_key_salt)
    : deriveKey(token);
  const plaintext = decrypt(blobs.get(row.blob_path), key, row.iv, row.auth_tag);

  purgeAfterLastView(db, blobs, row, accessCount);

  return { status: "opened", share: contentOf(row, plaintext) };
}

export function consumeE2eShare(
  db: DB,
  blobs: BlobStore,
  linkId: string,
  linkProof: Buffer,
  authKey: Buffer | null,
  visitor = "local",
): E2eConsumeOutcome {
  const now = Date.now();
  const row = findLiveRow(db, blobs, linkId, true, now);

  if (row.link_proof_hash === null || !hashesMatch(row.link_proof_hash, sha256HexOf(linkProof))) {
    throw notFound();
  }

  const lockOutcome = shareLockOutcome(row, now);
  if (lockOutcome) return lockOutcome;

  const authHash = row.auth_hash;
  if (authHash !== null) {
    const gateOutcome = passwordGate(
      db,
      row,
      visitor,
      now,
      authKey === null ? null : () => hashesMatch(authHash, sha256HexOf(authKey)),
    );
    if (gateOutcome) return gateOutcome;
  }

  const accessCount = claimView(db, blobs, row, now);

  const ciphertext = blobs.get(row.blob_path);

  purgeAfterLastView(db, blobs, row, accessCount);

  return { status: "opened", ciphertext, iv: row.iv };
}

/** Revoke a share by token, deleting its row and blob. Returns true if found. */
export function revokeShare(
  db: DB,
  blobs: BlobStore,
  token: string,
  revokeToken?: string,
): boolean {
  const row = db
    .prepare("SELECT id, blob_path, revoke_token_hash FROM shares WHERE token_hash = ?")
    .get(hashToken(token)) as Pick<ShareRow, "id" | "blob_path" | "revoke_token_hash"> | undefined;
  if (!row) return false;
  if (row.revoke_token_hash !== null) {
    if (revokeToken === undefined || !hashesMatch(row.revoke_token_hash, hashToken(revokeToken))) {
      return false;
    }
  }
  purge(db, blobs, row);
  return true;
}
