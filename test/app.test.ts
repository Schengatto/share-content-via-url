import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const getDb = vi.fn(() => ({ db: true }));
const fsBlobStore = vi.fn((dir: string) => ({ store: dir }));
const purgeExpired = vi.fn();

vi.mock("../lib/db", () => ({ getDb }));
vi.mock("../lib/blob-store", () => ({ fsBlobStore }));
vi.mock("../lib/cleanup", () => ({ purgeExpired }));

const origDataDir = process.env.DATA_DIR;
const origPublicOrigin = process.env.PUBLIC_ORIGIN;

beforeEach(() => {
  vi.resetModules();
  getDb.mockClear();
  fsBlobStore.mockClear();
  purgeExpired.mockClear();
  delete process.env.DATA_DIR;
  delete process.env.PUBLIC_ORIGIN;
});

afterEach(() => {
  if (origDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = origDataDir;
  if (origPublicOrigin === undefined) delete process.env.PUBLIC_ORIGIN;
  else process.env.PUBLIC_ORIGIN = origPublicOrigin;
});

describe("shareUrl", () => {
  it("uses the request origin when PUBLIC_ORIGIN is unset", async () => {
    const app = await import("../lib/app");
    expect(app.shareUrl("http://localhost:3000", "abc")).toBe("http://localhost:3000/s/abc");
  });

  it("prefers PUBLIC_ORIGIN over the request origin, without trailing slashes", async () => {
    process.env.PUBLIC_ORIGIN = "https://share-secret.schengatto.com/";
    const app = await import("../lib/app");
    expect(app.shareUrl("https://0.0.0.0:3000", "abc")).toBe(
      "https://share-secret.schengatto.com/s/abc",
    );
  });
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
