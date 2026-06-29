import { describe, it, expect } from "vitest";
import {
  generateToken,
  hashToken,
  deriveKey,
  encrypt,
  decrypt,
} from "../lib/crypto";

describe("crypto", () => {
  it("generates a 256-bit base64url token", () => {
    const t = generateToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(t, "base64url").length).toBe(32);
  });

  it("generates a different token each time", () => {
    expect(generateToken()).not.toBe(generateToken());
  });

  it("hashToken is a deterministic sha256 hex that is not the token", () => {
    const t = generateToken();
    const h1 = hashToken(t);
    const h2 = hashToken(t);
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(64);
    expect(h1).not.toBe(t);
  });

  it("deriveKey returns a 32-byte key deterministically from the token", () => {
    const t = generateToken();
    const k1 = deriveKey(t);
    const k2 = deriveKey(t);
    expect(k1.length).toBe(32);
    expect(k1.equals(k2)).toBe(true);
  });

  it("derives different keys from different tokens", () => {
    expect(deriveKey(generateToken()).equals(deriveKey(generateToken()))).toBe(
      false,
    );
  });

  it("round-trips encryption and decryption", () => {
    const key = deriveKey(generateToken());
    const plaintext = Buffer.from("hello secret world", "utf8");
    const { ciphertext, iv, authTag } = encrypt(plaintext, key);
    expect(ciphertext.equals(plaintext)).toBe(false);
    expect(iv.length).toBe(12);
    expect(authTag.length).toBe(16);
    const decrypted = decrypt(ciphertext, key, iv, authTag);
    expect(decrypted.equals(plaintext)).toBe(true);
  });

  it("fails to decrypt when the auth tag is tampered with", () => {
    const key = deriveKey(generateToken());
    const { ciphertext, iv, authTag } = encrypt(Buffer.from("data"), key);
    const bad = Buffer.from(authTag);
    bad[0] ^= 0xff;
    expect(() => decrypt(ciphertext, key, iv, bad)).toThrow();
  });

  it("fails to decrypt with the wrong key", () => {
    const { ciphertext, iv, authTag } = encrypt(
      Buffer.from("data"),
      deriveKey(generateToken()),
    );
    expect(() =>
      decrypt(ciphertext, deriveKey(generateToken()), iv, authTag),
    ).toThrow();
  });
});
