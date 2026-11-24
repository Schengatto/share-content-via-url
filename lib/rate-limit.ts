export interface RateLimiterOptions {
  /** Max allowed requests per window. */
  limit: number;
  /** Window length in ms. */
  windowMs: number;
  /** Clock, injectable for testing. */
  now?: () => number;
}

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterMs: number;
}

export interface RateLimiter {
  /** Record a hit for `key`; returns true if still within the limit. */
  allow(key: string): boolean;
  /** Record a hit for `key`; also reports how long until the window resets when refused. */
  check(key: string): RateLimitDecision;
}

/** Fixed-window in-memory rate limiter. Sufficient for a single-instance MVP. */
export function createRateLimiter(opts: RateLimiterOptions): RateLimiter {
  const { limit, windowMs } = opts;
  const now = opts.now ?? Date.now;
  const windows = new Map<string, { start: number; count: number }>();
  let lastSweep = now();

  // Drop windows whose period has elapsed so the map stays bounded to the set
  // of recently-active keys instead of growing once per distinct key forever.
  function sweep(t: number) {
    if (t - lastSweep < windowMs) return;
    for (const [k, w] of windows) {
      if (t - w.start >= windowMs) windows.delete(k);
    }
    lastSweep = t;
  }

  function check(key: string): RateLimitDecision {
    const t = now();
    sweep(t);
    const w = windows.get(key);
    if (!w || t - w.start >= windowMs) {
      windows.set(key, { start: t, count: 1 });
      return { allowed: true, retryAfterMs: 0 };
    }
    if (w.count >= limit) return { allowed: false, retryAfterMs: w.start + windowMs - t };
    w.count += 1;
    return { allowed: true, retryAfterMs: 0 };
  }

  return { check, allow: (key) => check(key).allowed };
}

/** Shared limiter for share creation (10 per minute per IP). */
export const shareCreationLimiter = createRateLimiter({
  limit: Number(process.env.RATE_LIMIT ?? 10),
  windowMs: 60_000,
});

export const REVEAL_LIMIT_PER_MINUTE = 30;
export const PASSWORD_ATTEMPT_LIMIT_PER_MINUTE = 10;
export const REVOKE_LIMIT_PER_MINUTE = 20;

export const revealLimiter = createRateLimiter({ limit: REVEAL_LIMIT_PER_MINUTE, windowMs: 60_000 });
export const passwordAttemptLimiter = createRateLimiter({
  limit: PASSWORD_ATTEMPT_LIMIT_PER_MINUTE,
  windowMs: 60_000,
});
export const revokeLimiter = createRateLimiter({ limit: REVOKE_LIMIT_PER_MINUTE, windowMs: 60_000 });
