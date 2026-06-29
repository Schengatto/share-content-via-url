import { getDb, type DB } from "./db";
import { fsBlobStore, type BlobStore } from "./blob-store";
import { purgeExpired } from "./cleanup";

/** Shared runtime wiring for routes and pages (Node runtime only). */

let blobsSingleton: BlobStore | null = null;
let started = false;

export function appDb(): DB {
  return getDb();
}

export function appBlobs(): BlobStore {
  if (!blobsSingleton) {
    const dir = process.env.DATA_DIR ?? "./data";
    blobsSingleton = fsBlobStore(`${dir}/blobs`);
  }
  return blobsSingleton;
}

/**
 * Run the bulk cleanup once on startup, then on a background interval so that
 * time-expired shares that are never re-accessed don't linger on disk until the
 * next restart. (`consumeShare` still purges individual rows lazily on access.)
 */
export function ensureStarted(): void {
  if (started) return;
  started = true;
  const db = appDb();
  const blobs = appBlobs();
  purgeExpired(db, blobs);

  const intervalMs = Number(process.env.CLEANUP_INTERVAL_MS ?? 3_600_000);
  if (Number.isFinite(intervalMs) && intervalMs > 0) {
    const timer = setInterval(() => purgeExpired(db, blobs), intervalMs);
    // Don't keep the process (or test runner) alive just for cleanup.
    timer.unref?.();
  }
}
