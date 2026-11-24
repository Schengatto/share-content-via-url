import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword } from "../lib/password";

describe("password hashing", () => {
  it("verifies the password it hashed", () => {
    expect(verifyPassword("heron-42", hashPassword("heron-42"))).toBe(true);
  });

  it("rejects a wrong password", () => {
    expect(verifyPassword("heron-43", hashPassword("heron-42"))).toBe(false);
  });

  it("stores the algorithm, cost parameters, salt and hash in one string", () => {
    const parts = hashPassword("heron-42").split("$");
    expect(parts.slice(0, 4)).toEqual(["scrypt", "32768", "8", "1"]);
    expect(Buffer.from(parts[4], "base64")).toHaveLength(16);
    expect(Buffer.from(parts[5], "base64")).toHaveLength(32);
  });

  it("salts every hash, so the same password never hashes the same way twice", () => {
    expect(hashPassword("heron-42")).not.toBe(hashPassword("heron-42"));
  });

  it("rejects malformed stored hashes", () => {
    const [, , , , salt, hash] = hashPassword("heron-42").split("$");
    const malformed = [
      "",
      "heron-42",
      `bcrypt$32768$8$1$${salt}$${hash}`,
      `scrypt$1000$8$1$${salt}$${hash}`,
      `scrypt$1073741824$8$1$${salt}$${hash}`,
      `scrypt$32768$8$9$${salt}$${hash}`,
      `scrypt$32768$8$1$$${hash}`,
      `scrypt$32768$8$1$${salt}$`,
      `scrypt$32768$8$1$${salt}$${hash}$extra`,
    ];
    expect(malformed.map((stored) => verifyPassword("heron-42", stored))).toEqual(malformed.map(() => false));
  });
});
