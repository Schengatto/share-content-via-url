import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fsBlobStore } from "../lib/blob-store";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "blobstore-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("blob-store.fsBlobStore", () => {
  it("creates the target directory recursively", () => {
    const dir = join(root, "a", "b", "blobs");
    fsBlobStore(dir);
    expect(existsSync(dir)).toBe(true);
  });

  it("round-trips a blob through put/get", () => {
    const store = fsBlobStore(join(root, "blobs"));
    const data = Buffer.from("encrypted-bytes");
    store.put("id-1", data);
    expect(store.get("id-1")).toEqual(data);
  });

  it("keeps blobs isolated by id", () => {
    const store = fsBlobStore(join(root, "blobs"));
    store.put("id-1", Buffer.from("one"));
    store.put("id-2", Buffer.from("two"));
    expect(store.get("id-1").toString()).toBe("one");
    expect(store.get("id-2").toString()).toBe("two");
  });

  it("delete removes the blob", () => {
    const store = fsBlobStore(join(root, "blobs"));
    store.put("id-1", Buffer.from("x"));
    store.delete("id-1");
    expect(() => store.get("id-1")).toThrow();
  });

  it("delete is a no-op for a missing blob", () => {
    const store = fsBlobStore(join(root, "blobs"));
    expect(() => store.delete("does-not-exist")).not.toThrow();
  });
});
