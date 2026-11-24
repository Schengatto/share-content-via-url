import { describe, it, expect } from "vitest";
import { createVisitorLock } from "../lib/visitor-lock";

function lockWithClock(start = 1000) {
  const clock = { now: start };
  const lock = createVisitorLock({ failures: 3, lockMs: 60_000, now: () => clock.now });
  return { lock, clock };
}

describe("visitor lock", () => {
  it("locks a key for the lock duration on the failure that reaches the threshold", () => {
    const { lock } = lockWithClock();
    expect(lock.recordFailure("a")).toBe(0);
    expect(lock.recordFailure("a")).toBe(0);
    expect(lock.lockedForMs("a")).toBe(0);
    expect(lock.recordFailure("a")).toBe(60_000);
    expect(lock.lockedForMs("a")).toBe(60_000);
  });

  it("reports the remaining lock time and unlocks when it ends", () => {
    const { lock, clock } = lockWithClock();
    for (let failure = 0; failure < 3; failure++) lock.recordFailure("a");
    clock.now += 20_000;
    expect(lock.lockedForMs("a")).toBe(40_000);
    clock.now += 40_000;
    expect(lock.lockedForMs("a")).toBe(0);
    expect(lock.recordFailure("a")).toBe(0);
  });

  it("tracks keys independently", () => {
    const { lock } = lockWithClock();
    for (let failure = 0; failure < 3; failure++) lock.recordFailure("a");
    expect(lock.lockedForMs("a")).toBe(60_000);
    expect(lock.lockedForMs("b")).toBe(0);
    expect(lock.recordFailure("b")).toBe(0);
  });

  it("forgets failures once the window since the first one has passed", () => {
    const { lock, clock } = lockWithClock();
    lock.recordFailure("a");
    lock.recordFailure("a");
    clock.now += 60_000;
    expect(lock.recordFailure("a")).toBe(0);
    expect(lock.recordFailure("a")).toBe(0);
    expect(lock.recordFailure("a")).toBe(60_000);
  });

  it("forgets failures of a cleared key", () => {
    const { lock } = lockWithClock();
    lock.recordFailure("a");
    lock.recordFailure("a");
    lock.clear("a");
    expect(lock.recordFailure("a")).toBe(0);
    expect(lock.recordFailure("a")).toBe(0);
  });
});
