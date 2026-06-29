import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

/** Storage for encrypted content blobs, keyed by an opaque id. */
export interface BlobStore {
  put(id: string, data: Buffer): void;
  get(id: string): Buffer;
  delete(id: string): void;
}

/** Filesystem-backed blob store. Blobs are written under `dir`. */
export function fsBlobStore(dir: string): BlobStore {
  mkdirSync(dir, { recursive: true });
  const pathOf = (id: string) => join(dir, id);
  return {
    put: (id, data) => writeFileSync(pathOf(id), data),
    get: (id) => readFileSync(pathOf(id)),
    delete: (id) => rmSync(pathOf(id), { force: true }),
  };
}
