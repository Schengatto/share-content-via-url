import { describe, it, expect } from "vitest";
import { buildContentSecurityPolicy, generateNonce } from "../lib/content-security-policy";

function directivesOf(policy: string): string[] {
  return policy.split("; ");
}

function scriptSourceOf(policy: string): string {
  return directivesOf(policy).find((directive) => directive.startsWith("script-src "))!;
}

describe("buildContentSecurityPolicy", () => {
  it("emits exactly the expected directives in production", () => {
    expect(directivesOf(buildContentSecurityPolicy("abc", false))).toEqual([
      "default-src 'self'",
      "script-src 'self' 'nonce-abc' 'strict-dynamic'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self'",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ]);
  });

  it("never allows inline or eval scripts in production", () => {
    const policy = buildContentSecurityPolicy("abc", false);
    expect(scriptSourceOf(policy)).not.toContain("'unsafe-inline'");
    expect(policy).not.toContain("'unsafe-eval'");
  });

  it("adds unsafe-eval to script-src only in development", () => {
    const policy = buildContentSecurityPolicy("abc", true);
    expect(scriptSourceOf(policy)).toContain("'unsafe-eval'");
    expect(scriptSourceOf(policy)).not.toContain("'unsafe-inline'");
  });
});

describe("generateNonce", () => {
  it("returns base64 of 16 bytes", () => {
    const nonce = generateNonce();
    expect(Buffer.from(nonce, "base64")).toHaveLength(16);
    expect(Buffer.from(nonce, "base64").toString("base64")).toBe(nonce);
  });

  it("differs between calls", () => {
    expect(generateNonce()).not.toBe(generateNonce());
  });
});
