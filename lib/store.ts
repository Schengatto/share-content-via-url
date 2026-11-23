import { randomUUID } from "node:crypto";
import { LEGACY_PAYLOAD_FORMAT, SEALED_PAYLOAD_FORMAT, scrubDeletedData, type DB } from "./db";
import type { BlobStore } from "./blob-store";
import { generateToken, hashToken, deriveKey, encrypt, decrypt } from "./crypto";
import { openPayload, sealPayload } from "./sealed-payload";

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

export interface CreateInput {
  kind: "text" | "file";
  content: Buffer;
  mime: string;
  filename?: string;
  /** epoch ms; null = no time limit */
  expiresAt?: number | null;
  /** 1..3; null = unlimited */
  maxAccesses?: number | null;
}

export interface CreateResult {
  token: string;
  id: string;
}

export interface ConsumeResult {
  kind: "text" | "file";
  mime: string;
  filename: string | null;
  content: Buffer;
}

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
}

export type ShareStatus = { available: true } | { available: false; status: 404 | 410 };

type UsageFields = Pick<ShareRow, "expires_at" | "max_accesses" | "access_count">;

function isUsedUp(row: UsageFields, now: number): boolean {
  return (
    (row.expires_at !== null && now > row.expires_at) ||
    (row.max_accesses !== null && row.access_count >= row.max_accesses)
  );
}

export function shareStatus(db: DB, token: string): ShareStatus {
  const row = db
    .prepare("SELECT expires_at, max_accesses, access_count FROM shares WHERE token_hash = ?")
    .get(hashToken(token)) as UsageFields | undefined;
  if (!row) return { available: false, status: 404 };
  if (isUsedUp(row, Date.now())) return { available: false, status: 410 };
  return { available: true };
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
  const maxAccesses = input.maxAccesses ?? null;
  if (maxAccesses !== null && ![1, 2, 3].includes(maxAccesses)) {
    throw new ShareError("max_accesses must be 1..3", 400, "BAD_MAX_ACCESSES");
  }

  const token = generateToken();
  const key = deriveKey(token);
  const payload = sealPayload({ filename: input.filename ?? null, mime: input.mime }, input.content);
  const { ciphertext, iv, authTag } = encrypt(payload, key);

  const id = randomUUID();
  const blobPath = id;

  db.transaction(() => {
    db.prepare(
      `INSERT INTO shares
        (id, token_hash, kind, payload_format, blob_path, iv, auth_tag,
         expires_at, max_accesses, access_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    ).run(
      id,
      hashToken(token),
      input.kind,
      SEALED_PAYLOAD_FORMAT,
      blobPath,
      iv,
      authTag,
      input.expiresAt ?? null,
      maxAccesses,
      Date.now(),
    );
    blobs.put(blobPath, ciphertext);
  })();

  return { token, id };
}

/**
 * Validate, atomically consume one access, decrypt and return the content.
 * Purges the share when expired/exhausted. Throws ShareError(404|410).
 */
export async function consumeShare(
  db: DB,
  blobs: BlobStore,
  token: string,
): Promise<ConsumeResult> {
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

  return contentOf(row, plaintext);
}

/** Revoke a share by token, deleting its row and blob. Returns true if found. */
export function revokeShare(db: DB, blobs: BlobStore, token: string): boolean {
  const row = db
    .prepare("SELECT id, blob_path FROM shares WHERE token_hash = ?")
    .get(hashToken(token)) as Pick<ShareRow, "id" | "blob_path"> | undefined;
  if (!row) return false;
  purge(db, blobs, row);
  return true;
}
