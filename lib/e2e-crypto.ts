import { MAX_SIZE } from "./file-support";
import type { PayloadMetadata } from "./sealed-payload";

export const E2E_FORMAT = "e2e-v1";
export const E2E_KDF_ITERATIONS = 600_000;
export const E2E_SALT_BYTES = 16;
export const E2E_IV_BYTES = 12;
export const E2E_MIN_CIPHERTEXT_BYTES = 20;

const KEY_BYTES = 32;
const HEADER_LENGTH_BYTES = 4;
const AUTH_TAG_BITS = 128;
const PADDING_MIN_BUCKET_BYTES = 1024;
const PADDING_POWER_OF_TWO_LIMIT_BYTES = 1024 * 1024;
const BASE64_CHUNK_BYTES = 32768;
const WELL_FORMED_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const BASE64_URL_PATTERN = /^[A-Za-z0-9_-]*$/;
const ADDITIONAL_DATA = new TextEncoder().encode("share-secret:e2e:v1");
const LINK_PROOF_INFO = new TextEncoder().encode("share-secret:e2e:v1:link-proof");
const AUTH_INFO = new TextEncoder().encode("share-secret:e2e:v1:auth");
const ENCRYPTION_INFO = new TextEncoder().encode("share-secret:e2e:v1:enc");

export interface E2eTextUpload {
  fragmentKey: string;
  ciphertext: Uint8Array<ArrayBuffer>;
  iv: string;
  salt: string;
  kdfIterations: number;
  linkProofHash: string;
  authHash: string | null;
}

export interface RevealProofs {
  linkProof: string;
  authKey: string;
  encKey: CryptoKey;
}

export function toBase64Url(bytes: Uint8Array): string {
  const binaryChunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_BYTES) {
    binaryChunks.push(String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK_BYTES)));
  }
  return btoa(binaryChunks.join("")).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  if (!BASE64_URL_PATTERN.test(text)) {
    throw new Error("Invalid base64url text");
  }
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function isWellFormedKey(text: string): boolean {
  return WELL_FORMED_KEY_PATTERN.test(text);
}

export function paddedPayloadLength(unpaddedLength: number): number {
  if (unpaddedLength <= PADDING_MIN_BUCKET_BYTES) {
    return PADDING_MIN_BUCKET_BYTES;
  }
  const bucket =
    unpaddedLength <= PADDING_POWER_OF_TWO_LIMIT_BYTES
      ? 2 ** (32 - Math.clz32(unpaddedLength - 1))
      : Math.ceil(unpaddedLength / PADDING_POWER_OF_TWO_LIMIT_BYTES) * PADDING_POWER_OF_TWO_LIMIT_BYTES;
  return bucket > MAX_SIZE ? Math.max(unpaddedLength, MAX_SIZE) : bucket;
}

export function sealPayloadBytes(metadata: PayloadMetadata, content: Uint8Array): Uint8Array<ArrayBuffer> {
  const header = new TextEncoder().encode(
    JSON.stringify({ filename: metadata.filename, mime: metadata.mime, length: content.length }),
  );
  const unpaddedLength = HEADER_LENGTH_BYTES + header.length + content.length;
  const payload = new Uint8Array(paddedPayloadLength(unpaddedLength));
  new DataView(payload.buffer).setUint32(0, header.length);
  payload.set(header, HEADER_LENGTH_BYTES);
  payload.set(content, HEADER_LENGTH_BYTES + header.length);
  return payload;
}

export function openPayloadBytes(payload: Uint8Array): PayloadMetadata & { content: Uint8Array } {
  const headerLength = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(0);
  const headerEnd = HEADER_LENGTH_BYTES + headerLength;
  if (headerEnd > payload.length) {
    throw new Error("Truncated payload");
  }
  const metadata = JSON.parse(
    new TextDecoder().decode(payload.subarray(HEADER_LENGTH_BYTES, headerEnd)),
  ) as PayloadMetadata & { length?: unknown };
  const contentEnd = typeof metadata.length === "number" ? headerEnd + metadata.length : payload.length;
  if (!Number.isSafeInteger(contentEnd) || contentEnd < headerEnd || contentEnd > payload.length) {
    throw new Error("Truncated payload");
  }
  return { filename: metadata.filename, mime: metadata.mime, content: payload.subarray(headerEnd, contentEnd) };
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(length));
}

async function hkdfKeyMaterial(inputKeyMaterial: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", inputKeyMaterial, "HKDF", false, ["deriveBits", "deriveKey"]);
}

async function deriveProof(
  keyMaterial: CryptoKey,
  salt: Uint8Array<ArrayBuffer>,
  info: Uint8Array<ArrayBuffer>,
): Promise<string> {
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, keyMaterial, KEY_BYTES * 8);
  return toBase64Url(new Uint8Array(bits));
}

async function derivePasswordBytes(
  password: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const passwordKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password.normalize("NFC")),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    passwordKey,
    KEY_BYTES * 8,
  );
  return new Uint8Array(bits);
}

export async function deriveRevealProofs(
  fragmentKey: string,
  salt: string,
  kdfIterations: number,
  password: string,
): Promise<RevealProofs> {
  if (!isWellFormedKey(fragmentKey)) {
    throw new Error("Malformed fragment key");
  }
  const keyBytes = fromBase64Url(fragmentKey);
  const saltBytes = fromBase64Url(salt);
  const keyOnlyMaterial = await hkdfKeyMaterial(keyBytes);
  const linkProof = await deriveProof(keyOnlyMaterial, saltBytes, LINK_PROOF_INFO);
  if (kdfIterations <= 0) {
    return { linkProof, authKey: "", encKey: await deriveEncryptionKey(keyOnlyMaterial, saltBytes) };
  }
  const passwordBytes = await derivePasswordBytes(password, saltBytes, kdfIterations);
  const combinedKeyMaterial = await hkdfKeyMaterial(new Uint8Array([...keyBytes, ...passwordBytes]));
  return {
    linkProof,
    authKey: await deriveProof(combinedKeyMaterial, saltBytes, AUTH_INFO),
    encKey: await deriveEncryptionKey(combinedKeyMaterial, saltBytes),
  };
}

async function deriveEncryptionKey(keyMaterial: CryptoKey, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: ENCRYPTION_INFO },
    keyMaterial,
    { name: "AES-GCM", length: KEY_BYTES * 8 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptText(text: string, password?: string): Promise<E2eTextUpload> {
  const fragmentKey = toBase64Url(randomBytes(KEY_BYTES));
  const salt = toBase64Url(randomBytes(E2E_SALT_BYTES));
  const ivBytes = randomBytes(E2E_IV_BYTES);
  const kdfIterations = password ? E2E_KDF_ITERATIONS : 0;
  const { linkProof, authKey, encKey } = await deriveRevealProofs(fragmentKey, salt, kdfIterations, password ?? "");
  const sealedPayload = sealPayloadBytes({ filename: null, mime: "text/plain" }, new TextEncoder().encode(text));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: ivBytes, additionalData: ADDITIONAL_DATA, tagLength: AUTH_TAG_BITS },
    encKey,
    sealedPayload,
  );
  return {
    fragmentKey,
    ciphertext: new Uint8Array(encrypted),
    iv: toBase64Url(ivBytes),
    salt,
    kdfIterations,
    linkProofHash: await sha256Hex(fromBase64Url(linkProof)),
    authHash: authKey ? await sha256Hex(fromBase64Url(authKey)) : null,
  };
}

export async function decryptText(encKey: CryptoKey, ciphertext: string, iv: string): Promise<string> {
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64Url(iv), additionalData: ADDITIONAL_DATA, tagLength: AUTH_TAG_BITS },
    encKey,
    fromBase64Url(ciphertext),
  );
  return new TextDecoder().decode(openPayloadBytes(new Uint8Array(decrypted)).content);
}
