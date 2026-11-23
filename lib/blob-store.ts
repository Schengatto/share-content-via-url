import {
  closeSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

/** Storage for encrypted content blobs, keyed by an opaque id. */
export interface BlobStore {
  put(id: string, data: Buffer): void;
  get(id: string): Buffer;
  delete(id: string): void;
  list(): string[];
}

const OWNER_ONLY = 0o600;
const OVERWRITE_CHUNK_BYTES = 64 * 1024;

function openIfPresent(path: string): number | null {
  try {
    return openSync(path, "r+");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function overwriteWithZeros(fileDescriptor: number): void {
  const { size } = fstatSync(fileDescriptor);
  const zeros = Buffer.alloc(Math.min(size, OVERWRITE_CHUNK_BYTES));
  for (let position = 0; position < size; position += zeros.length) {
    writeSync(fileDescriptor, zeros, 0, Math.min(zeros.length, size - position), position);
  }
  fsyncSync(fileDescriptor);
}

function shred(path: string): void {
  const fileDescriptor = openIfPresent(path);
  if (fileDescriptor === null) return;
  try {
    overwriteWithZeros(fileDescriptor);
  } finally {
    closeSync(fileDescriptor);
  }
  rmSync(path, { force: true });
}

/** Filesystem-backed blob store. Blobs are written under `dir`, readable by the owner only, and zeroed before removal. */
export function fsBlobStore(dir: string): BlobStore {
  mkdirSync(dir, { recursive: true });
  const pathOf = (id: string) => join(dir, id);
  return {
    put: (id, data) => writeFileSync(pathOf(id), data, { mode: OWNER_ONLY }),
    get: (id) => readFileSync(pathOf(id)),
    delete: (id) => shred(pathOf(id)),
    list: () => readdirSync(dir),
  };
}
