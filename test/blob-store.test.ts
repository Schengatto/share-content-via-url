import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, linkSync, readFileSync, statSync } from "node:fs";
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

  it("delete zeroes the blob content before removing it", () => {
    const dir = join(root, "blobs");
    const store = fsBlobStore(dir);
    const data = Buffer.alloc(150_000, 0xab);
    store.put("id-1", data);
    const survivingLink = join(root, "hard-link");
    linkSync(join(dir, "id-1"), survivingLink);

    store.delete("id-1");

    expect(existsSync(join(dir, "id-1"))).toBe(false);
    expect(readFileSync(survivingLink).equals(Buffer.alloc(data.length))).toBe(true);
  });

  it.skipIf(process.platform === "win32")("writes blobs readable by the owner only", () => {
    const dir = join(root, "blobs");
    const store = fsBlobStore(dir);
    store.put("id-1", Buffer.from("x"));
    expect(statSync(join(dir, "id-1")).mode & 0o777).toBe(0o600);
  });

  it("lists the stored blob ids", () => {
    const store = fsBlobStore(join(root, "blobs"));
    store.put("id-1", Buffer.from("one"));
    store.put("id-2", Buffer.from("two"));
    expect(store.list().sort()).toEqual(["id-1", "id-2"]);
  });
});
