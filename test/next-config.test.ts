import { describe, it, expect } from "vitest";
import nextConfig from "../next.config.mjs";

type HeaderRule = { source: string; headers: { key: string; value: string }[] };

async function headersFor(source: string): Promise<Record<string, string>> {
  const rules = (await nextConfig.headers!()) as HeaderRule[];
  return Object.fromEntries(
    rules
      .filter((rule) => rule.source === source)
      .flatMap((rule) => rule.headers.map(({ key, value }) => [key, value])),
  );
}

describe("next.config headers", () => {
  it.each(["/s/:path*", "/api/share/:path*"])("marks %s as no-store", async (source) => {
    expect((await headersFor(source))["Cache-Control"]).toBe("no-store");
  });

  it("keeps the security headers on every path", async () => {
    const globalHeaders = await headersFor("/:path*");
    expect(globalHeaders["Referrer-Policy"]).toBe("no-referrer");
    expect(globalHeaders["X-Content-Type-Options"]).toBe("nosniff");
    expect(globalHeaders["Content-Security-Policy"]).toBeUndefined();
  });

  it("locks down api responses with a restrictive Content-Security-Policy", async () => {
    expect((await headersFor("/api/:path*"))["Content-Security-Policy"]).toBe(
      "default-src 'none'; frame-ancestors 'none'",
    );
  });

  it("does not disable caching for the static assets", async () => {
    expect((await headersFor("/:path*"))["Cache-Control"]).toBeUndefined();
  });
});
