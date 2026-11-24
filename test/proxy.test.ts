import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import nextConfig from "../next.config.mjs";
import { config, proxy } from "../proxy";

function proxyRuns(url: string, headers?: Record<string, string>): boolean {
  return unstable_doesMiddlewareMatch({ config, nextConfig, url, headers });
}

describe("proxy matcher", () => {
  it.each(["/", "/s/abc", "/apifoo"])("runs on %s", (url) => {
    expect(proxyRuns(url)).toBe(true);
  });

  it.each(["/_next/static/x.js", "/_next/image", "/favicon.ico", "/api", "/api/share"])(
    "skips %s",
    (url) => {
      expect(proxyRuns(url)).toBe(false);
    },
  );

  it("skips router prefetch requests", () => {
    expect(proxyRuns("/s/abc", { "next-router-prefetch": "1" })).toBe(false);
  });

  it("still runs on browser document prefetches so they carry a nonce", () => {
    expect(proxyRuns("/s/abc", { purpose: "prefetch" })).toBe(true);
  });
});

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

  it("forwards the policy to the rendering request", () => {
    const response = proxy(new NextRequest("http://localhost/s/x"));
    const policy = response.headers.get("Content-Security-Policy");
    const forwardedHeaderNames = response.headers.get("x-middleware-override-headers") ?? "";
    expect(forwardedHeaderNames).toContain("content-security-policy");
    expect(response.headers.get("x-middleware-request-content-security-policy")).toBe(policy);
  });
});
