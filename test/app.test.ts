import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const getDb = vi.fn(() => ({ db: true }));
const fsBlobStore = vi.fn((dir: string) => ({ store: dir }));
const purgeExpired = vi.fn();

vi.mock("../lib/db", () => ({ getDb }));
vi.mock("../lib/blob-store", () => ({ fsBlobStore }));
vi.mock("../lib/cleanup", () => ({ purgeExpired }));

const origDataDir = process.env.DATA_DIR;

beforeEach(() => {
  vi.resetModules();
  getDb.mockClear();
  fsBlobStore.mockClear();
  purgeExpired.mockClear();
  delete process.env.DATA_DIR;
});

afterEach(() => {
  if (origDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = origDataDir;
});

describe("app wiring", () => {
  it("appDb delegates to getDb", async () => {
    const app = await import("../lib/app");
    expect(app.appDb()).toEqual({ db: true });
    expect(getDb).toHaveBeenCalledOnce();
  });

  it("appBlobs defaults to ./data/blobs", async () => {
    const app = await import("../lib/app");
    app.appBlobs();
    expect(fsBlobStore).toHaveBeenCalledWith("./data/blobs");
  });

  it("appBlobs honors DATA_DIR", async () => {
    process.env.DATA_DIR = "/custom";
    const app = await import("../lib/app");
    app.appBlobs();
    expect(fsBlobStore).toHaveBeenCalledWith("/custom/blobs");
  });

  it("appBlobs caches the store across calls", async () => {
    const app = await import("../lib/app");
    const a = app.appBlobs();
    const b = app.appBlobs();
    expect(a).toBe(b);
    expect(fsBlobStore).toHaveBeenCalledOnce();
  });

  it("ensureStarted runs the cleanup only once", async () => {
    const app = await import("../lib/app");
    app.ensureStarted();
    app.ensureStarted();
    expect(purgeExpired).toHaveBeenCalledOnce();
  });
});
