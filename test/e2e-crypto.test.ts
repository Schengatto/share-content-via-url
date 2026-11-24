import { describe, expect, it } from "vitest";
import {
  decryptText,
  deriveRevealProofs,
  E2E_IV_BYTES,
  E2E_SALT_BYTES,
  encryptText,
  fromBase64Url,
  isWellFormedKey,
  openPayloadBytes,
  paddedPayloadLength,
  sealPayloadBytes,
  sha256Hex,
  toBase64Url,
} from "../lib/e2e-crypto";
import { MAX_SIZE } from "../lib/file-support";
import { sealPayload } from "../lib/sealed-payload";

const TEXT_METADATA = { filename: null, mime: "text/plain" };
const SLOW_TEST_TIMEOUT_MS = 30_000;

async function decryptUpload(
  upload: Awaited<ReturnType<typeof encryptText>>,
  password: string,
  ciphertext: Uint8Array = upload.ciphertext,
) {
  const proofs = await deriveRevealProofs(upload.fragmentKey, upload.salt, upload.kdfIterations, password);
  return { proofs, plaintext: decryptText(proofs.encKey, toBase64Url(ciphertext), upload.iv) };
}

async function importRawAesKey(rawBase64Url: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", fromBase64Url(rawBase64Url), "AES-GCM", false, ["decrypt"]);
}

describe("e2e-crypto", () => {
  it("round trip without password", async () => {
    const upload = await encryptText("lantern-orbit");

    expect(upload.kdfIterations).toBe(0);
    expect(upload.authHash).toBeNull();
    expect(isWellFormedKey(upload.fragmentKey)).toBe(true);
    expect(fromBase64Url(upload.salt).length).toBe(E2E_SALT_BYTES);
    expect(fromBase64Url(upload.iv).length).toBe(E2E_IV_BYTES);
    expect(upload.linkProofHash).toMatch(/^[0-9a-f]{64}$/);

    const { proofs, plaintext } = await decryptUpload(upload, "");
    expect(proofs.authKey).toBe("");
    expect(await sha256Hex(fromBase64Url(proofs.linkProof))).toBe(upload.linkProofHash);
    expect(await plaintext).toBe("lantern-orbit");
  });

  it("treats an empty password as no password", async () => {
    const upload = await encryptText("plain", "");

    expect(upload.kdfIterations).toBe(0);
    expect(upload.authHash).toBeNull();
  });

  it("round trip with password", { timeout: SLOW_TEST_TIMEOUT_MS }, async () => {
    const upload = await encryptText("s3cret text", "correct horse");

    expect(upload.kdfIterations).toBe(600000);
    const { proofs, plaintext } = await decryptUpload(upload, "correct horse");
    expect(await sha256Hex(fromBase64Url(proofs.authKey))).toBe(upload.authHash);
    expect(await sha256Hex(fromBase64Url(proofs.linkProof))).toBe(upload.linkProofHash);
    expect(await plaintext).toBe("s3cret text");
  });

  it("wrong password keeps linkProof, changes authKey and fails to decrypt", { timeout: SLOW_TEST_TIMEOUT_MS }, async () => {
    const upload = await encryptText("s3cret text", "correct horse");
    const right = await decryptUpload(upload, "correct horse");
    const wrong = await decryptUpload(upload, "wrong horse");

    expect(wrong.proofs.linkProof).toBe(right.proofs.linkProof);
    expect(wrong.proofs.authKey).not.toBe(right.proofs.authKey);
    await expect(wrong.plaintext).rejects.toThrow();
    await right.plaintext;
  });

  it("derives link proof, auth key and encryption key from separate infos", { timeout: SLOW_TEST_TIMEOUT_MS }, async () => {
    const upload = await encryptText("s3cret text", "correct horse");
    const { proofs } = await decryptUpload(upload, "correct horse");

    expect(proofs.linkProof).not.toBe(proofs.authKey);
    const ciphertext = toBase64Url(upload.ciphertext);
    await expect(decryptText(await importRawAesKey(proofs.linkProof), ciphertext, upload.iv)).rejects.toThrow();
    await expect(decryptText(await importRawAesKey(proofs.authKey), ciphertext, upload.iv)).rejects.toThrow();
    expect(proofs.encKey.extractable).toBe(false);
  });

  it("normalizes the password to NFC", { timeout: SLOW_TEST_TIMEOUT_MS }, async () => {
    const composed = "café-pass";
    const decomposed = "café-pass";
    const upload = await encryptText("accent", composed);
    const fromComposed = await decryptUpload(upload, composed);
    const fromDecomposed = await decryptUpload(upload, decomposed);

    expect(fromDecomposed.proofs.authKey).toBe(fromComposed.proofs.authKey);
    expect(await fromDecomposed.plaintext).toBe("accent");
  });

  it("appends the 16 byte tag to the ciphertext", async () => {
    const text = "tag length check";
    const upload = await encryptText(text);
    const sealed = sealPayloadBytes(TEXT_METADATA, new TextEncoder().encode(text));

    expect(upload.ciphertext.length).toBe(sealed.length + 16);
  });

  it("rejects a tampered ciphertext", async () => {
    const upload = await encryptText("untouched");
    const tampered = upload.ciphertext.slice();
    tampered[0] ^= 1;
    const { plaintext } = await decryptUpload(upload, "", tampered);

    await expect(plaintext).rejects.toThrow();
  });

  it("encrypts the same text to different outputs", async () => {
    const first = await encryptText("same");
    const second = await encryptText("same");

    expect(first.fragmentKey).not.toBe(second.fragmentKey);
    expect(first.iv).not.toBe(second.iv);
  });

  it("opens payloads sealed by the Buffer implementation", () => {
    const metadata = { filename: "note.txt", mime: "text/plain" };
    const content = new Uint8Array([0, 1, 2, 250, 255]);
    const opened = openPayloadBytes(new Uint8Array(sealPayload(metadata, Buffer.from(content))));

    expect(opened.filename).toBe("note.txt");
    expect(opened.mime).toBe("text/plain");
    expect(Array.from(opened.content)).toEqual(Array.from(content));
  });

  it("round trips content byte for byte, including trailing zero bytes", () => {
    const content = new Uint8Array([7, 0, 9, 0, 0]);
    const opened = openPayloadBytes(sealPayloadBytes(TEXT_METADATA, content));

    expect(opened.mime).toBe("text/plain");
    expect(opened.filename).toBeNull();
    expect(Array.from(opened.content)).toEqual(Array.from(content));
  });

  it("opens an old format payload without a length field to exactly its content", () => {
    const header = new TextEncoder().encode(JSON.stringify({ filename: null, mime: "text/plain" }));
    const content = new Uint8Array([4, 5, 6, 0]);
    const payload = new Uint8Array(4 + header.length + content.length);
    new DataView(payload.buffer).setUint32(0, header.length);
    payload.set(header, 4);
    payload.set(content, 4 + header.length);

    expect(Array.from(openPayloadBytes(payload).content)).toEqual(Array.from(content));
  });

  it("rejects a header length larger than the remaining bytes", () => {
    const header = new TextEncoder().encode(JSON.stringify({ filename: null, mime: "text/plain", length: 50 }));
    const payload = new Uint8Array(4 + header.length + 10);
    new DataView(payload.buffer).setUint32(0, header.length);
    payload.set(header, 4);

    expect(() => openPayloadBytes(payload)).toThrow();
  });

  it("rejects a negative header length", () => {
    const header = new TextEncoder().encode(JSON.stringify({ filename: null, mime: "text/plain", length: -1 }));
    const payload = new Uint8Array(4 + header.length + 10);
    new DataView(payload.buffer).setUint32(0, header.length);
    payload.set(header, 4);

    expect(() => openPayloadBytes(payload)).toThrow();
  });

  it("pads sealed payloads to the bucket length", () => {
    const small = sealPayloadBytes(TEXT_METADATA, new Uint8Array(3));
    const larger = sealPayloadBytes(TEXT_METADATA, new Uint8Array(300));
    const header = new TextEncoder().encode(JSON.stringify({ filename: null, mime: "text/plain", length: 2000 }));

    expect(small.length).toBe(1024);
    expect(larger.length).toBe(small.length);
    expect(sealPayloadBytes(TEXT_METADATA, new Uint8Array(2000)).length).toBe(
      paddedPayloadLength(4 + header.length + 2000),
    );
  });

  it("computes the padded payload length per bucket rule", () => {
    expect(paddedPayloadLength(1)).toBe(1024);
    expect(paddedPayloadLength(1024)).toBe(1024);
    expect(paddedPayloadLength(1025)).toBe(2048);
    expect(paddedPayloadLength(700_000)).toBe(1_048_576);
    expect(paddedPayloadLength(1_048_577)).toBe(2_097_152);
    expect(paddedPayloadLength(MAX_SIZE - 10)).toBe(MAX_SIZE);
    expect(paddedPayloadLength(MAX_SIZE + 50)).toBe(MAX_SIZE + 50);
  });

  it("rejects a truncated sealed payload", () => {
    expect(() => openPayloadBytes(new Uint8Array([0, 0, 0, 99, 1]))).toThrow();
  });

  it("detects malformed keys and base64url text", () => {
    const valid = "A".repeat(43);

    expect(isWellFormedKey(valid)).toBe(true);
    expect(isWellFormedKey("")).toBe(false);
    expect(isWellFormedKey("A".repeat(42))).toBe(false);
    expect(isWellFormedKey("A".repeat(44))).toBe(false);
    expect(isWellFormedKey(`${"A".repeat(42)}+`)).toBe(false);
    expect(isWellFormedKey(`${"A".repeat(42)}=`)).toBe(false);
    expect(() => fromBase64Url("ab+c")).toThrow();
  });

  it("rejects a malformed fragment key when deriving proofs", async () => {
    await expect(deriveRevealProofs("short", toBase64Url(new Uint8Array(16)), 0, "")).rejects.toThrow();
  });

  it("round trips a large payload through base64url", () => {
    const bytes = new Uint8Array(3 * 1024 * 1024);
    for (let offset = 0; offset < bytes.length; offset += 65536) {
      crypto.getRandomValues(bytes.subarray(offset, offset + 65536));
    }

    const encoded = toBase64Url(bytes);

    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(fromBase64Url(encoded)).equals(Buffer.from(bytes))).toBe(true);
  });
});
