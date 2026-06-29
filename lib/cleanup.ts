import type { DB } from "./db";
import type { BlobStore } from "./blob-store";

interface PurgeRow {
  id: string;
  blob_path: string;
}

/**
 * Delete every share that is time-expired or access-exhausted, removing both
 * the row and its blob. Returns how many were purged. Runs lazily (on access)
 * and on startup.
 */
export function purgeExpired(
  db: DB,
  blobs: BlobStore,
  now: number = Date.now(),
): number {
  const rows = db
    .prepare(
      `SELECT id, blob_path FROM shares
       WHERE (expires_at   IS NOT NULL AND expires_at < ?)
          OR (max_accesses IS NOT NULL AND access_count >= max_accesses)`,
    )
    .all(now) as PurgeRow[];

  const del = db.prepare("DELETE FROM shares WHERE id = ?");
  const run = db.transaction((batch: PurgeRow[]) => {
    for (const r of batch) {
      blobs.delete(r.blob_path);
      del.run(r.id);
    }
  });
  run(rows);

  return rows.length;
}
