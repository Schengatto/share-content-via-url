import {
  randomBytes,
  createHash,
  hkdfSync,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";

/**
 * Token-derived encryption for capability URLs.
 *
 * The token is a 256-bit random value carried only in the share URL. It is the
 * sole secret: the AES key is derived from it via HKDF and is never persisted.
 * Only `hashToken(token)` is stored, for lookup — it cannot be inverted to the
 * token, so an attacker with the DB/disk cannot derive the key.
 */

const TOKEN_BYTES = 32; // 256-bit token
const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // GCM nonce
const HKDF_SALT = "share-app:hkdf:v1";
const HKDF_INFO = "share-app:aes-256-gcm:v1";

/** Generate a fresh 256-bit token, base64url-encoded for use in the URL. */
export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/** SHA-256 (hex) of the token — the lookup key stored in the DB. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Derive the AES-256 key from the token via HKDF-SHA256. */
export function deriveKey(token: string): Buffer {
  const ikm = Buffer.from(token, "base64url");
  const derived = hkdfSync(
    "sha256",
    ikm,
    Buffer.from(HKDF_SALT),
    Buffer.from(HKDF_INFO),
    KEY_BYTES,
  );
  return Buffer.from(derived);
}

export interface EncryptResult {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
}

/** Encrypt with AES-256-GCM. Returns ciphertext, nonce and integrity tag. */
export function encrypt(plaintext: Buffer, key: Buffer): EncryptResult {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { ciphertext, iv, authTag };
}

/** Decrypt AES-256-GCM. Throws if the key, IV or auth tag do not verify. */
export function decrypt(
  ciphertext: Buffer,
  key: Buffer,
  iv: Buffer,
  authTag: Buffer,
): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
