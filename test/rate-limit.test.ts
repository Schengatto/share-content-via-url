import { describe, it, expect } from "vitest";
import { createRateLimiter } from "../lib/rate-limit";

describe("rate-limit", () => {
  it("allows requests up to the limit within the window", () => {
    let now = 1000;
    const rl = createRateLimiter({ limit: 3, windowMs: 60_000, now: () => now });
    expect(rl.allow("ip-a")).toBe(true);
    expect(rl.allow("ip-a")).toBe(true);
    expect(rl.allow("ip-a")).toBe(true);
    expect(rl.allow("ip-a")).toBe(false);
  });

  it("tracks keys independently", () => {
    let now = 1000;
    const rl = createRateLimiter({ limit: 1, windowMs: 60_000, now: () => now });
    expect(rl.allow("ip-a")).toBe(true);
    expect(rl.allow("ip-b")).toBe(true);
    expect(rl.allow("ip-a")).toBe(false);
  });

  it("reports how long until the window resets when refusing", () => {
    let now = 1000;
    const rl = createRateLimiter({ limit: 1, windowMs: 60_000, now: () => now });
    expect(rl.check("ip-a")).toEqual({ allowed: true, retryAfterMs: 0 });
    now += 20_000;
    expect(rl.check("ip-a")).toEqual({ allowed: false, retryAfterMs: 40_000 });
    now += 40_000;
    expect(rl.check("ip-a")).toEqual({ allowed: true, retryAfterMs: 0 });
  });

  it("resets after the window elapses", () => {
    let now = 1000;
    const rl = createRateLimiter({ limit: 1, windowMs: 60_000, now: () => now });
    expect(rl.allow("ip-a")).toBe(true);
    expect(rl.allow("ip-a")).toBe(false);
    now += 60_001;
    expect(rl.allow("ip-a")).toBe(true);
  });
});
