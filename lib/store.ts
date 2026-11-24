import { randomUUID } from "node:crypto";
import { LEGACY_PAYLOAD_FORMAT, SEALED_PAYLOAD_FORMAT, scrubDeletedData, type DB } from "./db";
import type { BlobStore } from "./blob-store";
import { generateToken, hashToken, hashesMatch, deriveKey, encrypt, decrypt } from "./crypto";
import { openPayload, sealPayload } from "./sealed-payload";
import { hashPassword, verifyPassword } from "./password";
import {
  LOCK_DURATION_MS,
  MAX_PASSWORD_LENGTH,
  MAX_TTL_SECONDS,
  MAX_VIEWS,
  MIN_PASSWORD_LENGTH,
  MIN_TTL_SECONDS,
  MIN_VIEWS,
  isValidPassword,
  isValidTtlSeconds,
  isValidViews,
} from "./share-options";

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
}

export type ShareStatus =
  | { available: true; passwordProtected: boolean; lockedUntil: number | null }
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
      "SELECT expires_at, max_accesses, access_count, password_hash, locked_until FROM shares WHERE token_hash = ?",
    )
    .get(hashToken(token)) as (UsageFields & Pick<ShareRow, "password_hash" | "locked_until">) | undefined;
  if (!row) return { available: false, status: 404 };
  const now = Date.now();
  if (isUsedUp(row, now)) return { available: false, status: 410 };
  return { available: true, passwordProtected: row.password_hash !== null, lockedUntil: activeLockUntil(row, now) };
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
  const key = deriveKey(token);
  const payload = sealPayload({ filename: input.filename ?? null, mime: input.mime }, input.content);
  const { ciphertext, iv, authTag } = encrypt(payload, key);

  const id = randomUUID();
  const blobPath = id;

  db.transaction(() => {
    db.prepare(
      `INSERT INTO shares
        (id, token_hash, kind, payload_format, blob_path, iv, auth_tag,
         expires_at, max_accesses, access_count, created_at, password_hash, revoke_token_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
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
    );
    blobs.put(blobPath, ciphertext);
  })();

  return { token, revokeToken, id };
}

/**
 * Validate, atomically consume one access, decrypt and return the content.
 * Purges the share when expired/exhausted. Throws ShareError(404|410).
 */
function lockedOutcome(db: DB, id: string, now: number): ConsumeOutcome {
  const current = db.prepare("SELECT locked_until FROM shares WHERE id = ?").get(id) as
    | { locked_until: number | null }
    | undefined;
  if (!current) throw new ShareError("Gone", 410, "GONE");
  return { status: "locked", retryAfterMs: Math.max(0, (current.locked_until ?? now) - now) };
}

export async function consumeShare(
  db: DB,
  blobs: BlobStore,
  token: string,
  password = "",
): Promise<ConsumeOutcome> {
  const tokenHash = hashToken(token);
  const row = db
    .prepare("SELECT * FROM shares WHERE token_hash = ?")
    .get(tokenHash) as ShareRow | undefined;

  if (!row) {
    throw new ShareError("Not found", 404, "NOT_FOUND");
  }

  const now = Date.now();
  if (isUsedUp(row, now)) {
    purge(db, blobs, row);
    throw new ShareError("Gone", 410, "GONE");
  }

  const lockedUntil = activeLockUntil(row, now);
  if (lockedUntil !== null) {
    return { status: "locked", retryAfterMs: lockedUntil - now };
  }

  if (row.password_hash !== null) {
    if (password === "") return { status: "password-required" };
    const claim = db
      .prepare("UPDATE shares SET locked_until = ? WHERE id = ? AND (locked_until IS NULL OR locked_until <= ?)")
      .run(now + LOCK_DURATION_MS, row.id, now);
    if (claim.changes !== 1) return lockedOutcome(db, row.id, now);
    if (!verifyPassword(password, row.password_hash)) {
      return { status: "wrong-password", retryAfterMs: LOCK_DURATION_MS };
    }
    db.prepare("UPDATE shares SET locked_until = NULL WHERE id = ?").run(row.id);
  }

  // Atomic, race-safe increment: only succeeds if still valid right now.
  const result = db
    .prepare(
      `UPDATE shares SET access_count = access_count + 1
       WHERE id = ?
         AND (max_accesses IS NULL OR access_count < max_accesses)
         AND (expires_at  IS NULL OR expires_at > ?)`,
    )
    .run(row.id, now);

  if (result.changes === 0) {
    purge(db, blobs, row);
    throw new ShareError("Gone", 410, "GONE");
  }

  const key = deriveKey(token);
  const plaintext = decrypt(blobs.get(row.blob_path), key, row.iv, row.auth_tag);

  const newCount = row.access_count + 1;
  if (row.max_accesses !== null && newCount >= row.max_accesses) {
    purge(db, blobs, row);
  }

  return { status: "opened", share: contentOf(row, plaintext) };
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
