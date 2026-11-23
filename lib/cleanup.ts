import { scrubDeletedData, type DB } from "./db";
import type { BlobStore } from "./blob-store";

interface PurgeRow {
  id: string;
  blob_path: string;
}

function deleteOrphanBlobs(db: DB, blobs: BlobStore): void {
  const referenced = new Set(db.prepare("SELECT blob_path FROM shares").pluck().all() as string[]);
  for (const blobId of blobs.list()) {
    if (!referenced.has(blobId)) blobs.delete(blobId);
  }
}

/**
 * Delete every share that is time-expired or access-exhausted. Rows go first,
 * in one transaction, then the journal is scrubbed and the blobs are shredded,
 * together with any blob no row references. Returns how many shares were purged.
 * Runs on startup and on a background interval.
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

  const deleteRow = db.prepare("DELETE FROM shares WHERE id = ?");
  db.transaction(() => rows.forEach((row) => deleteRow.run(row.id)))();
  if (rows.length > 0) scrubDeletedData(db);
  deleteOrphanBlobs(db, blobs);

  return rows.length;
}
