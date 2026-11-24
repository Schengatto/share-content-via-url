import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "../proxy";

function nonceOf(policy: string | null): string {
  return /'nonce-([^']+)'/.exec(policy ?? "")![1];
}

describe("proxy", () => {
  it("sets a nonce-based Content-Security-Policy on the response", () => {
    const policy = proxy(new NextRequest("http://localhost/s/x")).headers.get(
      "Content-Security-Policy",
    );
    expect(policy).toContain("'nonce-");
    expect(policy).toContain("'strict-dynamic'");
  });

  it("generates a different nonce for every request", () => {
    const first = proxy(new NextRequest("http://localhost/s/x"));
    const second = proxy(new NextRequest("http://localhost/s/x"));
    expect(nonceOf(first.headers.get("Content-Security-Policy"))).not.toBe(
      nonceOf(second.headers.get("Content-Security-Policy")),
    );
  });

  it("forwards the nonce and the policy to the rendering request", () => {
    const response = proxy(new NextRequest("http://localhost/s/x"));
    const policy = response.headers.get("Content-Security-Policy");
    const forwardedHeaderNames = response.headers.get("x-middleware-override-headers") ?? "";
    expect(forwardedHeaderNames).toContain("x-nonce");
    expect(forwardedHeaderNames).toContain("content-security-policy");
    expect(response.headers.get("x-middleware-request-x-nonce")).toBe(nonceOf(policy));
    expect(response.headers.get("x-middleware-request-content-security-policy")).toBe(policy);
  });
});
