import { LOCK_DURATION_MS, VISITOR_LOCK_FAILURES } from "./share-options";

export interface VisitorLockOptions {
  failures: number;
  lockMs: number;
  now?: () => number;
}

export interface VisitorLock {
  lockedForMs(key: string): number;
  recordFailure(key: string): number;
  clear(key: string): void;
}

interface FailureRecord {
  count: number;
  windowEndsAt: number;
  lockedUntil: number;
}

export function createVisitorLock({ failures, lockMs, now = () => Date.now() }: VisitorLockOptions): VisitorLock {
  const records = new Map<string, FailureRecord>();
  let lastSweep = now();

  function isStale(record: FailureRecord, time: number): boolean {
    return record.windowEndsAt <= time && record.lockedUntil <= time;
  }

  function sweep(time: number) {
    if (time - lastSweep < lockMs) return;
    for (const [key, record] of records) {
      if (isStale(record, time)) records.delete(key);
    }
    lastSweep = time;
  }

  function lockedForMs(key: string): number {
    const record = records.get(key);
    return record ? Math.max(0, record.lockedUntil - now()) : 0;
  }

  function recordFailure(key: string): number {
    const time = now();
    sweep(time);
    const current = records.get(key);
    const record =
      current && !isStale(current, time) ? current : { count: 0, windowEndsAt: time + lockMs, lockedUntil: 0 };
    record.count += 1;
    if (record.count >= failures) {
      record.count = 0;
      record.lockedUntil = time + lockMs;
    }
    records.set(key, record);
    return Math.max(0, record.lockedUntil - time);
  }

  return { lockedForMs, recordFailure, clear: (key) => void records.delete(key) };
}

export const visitorPasswordLock = createVisitorLock({ failures: VISITOR_LOCK_FAILURES, lockMs: LOCK_DURATION_MS });
