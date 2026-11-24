import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { openDb, type DB } from "../lib/db";
import type { BlobStore } from "../lib/blob-store";
import { createShare } from "../lib/store";
import { DEFAULT_TTL_SECONDS, LOCK_DURATION_MS, tokenFromShareUrl } from "../lib/share-options";

const wiring = vi.hoisted(() => ({ db: undefined as DB | undefined, blobs: undefined as BlobStore | undefined }));

vi.mock("../lib/app", () => ({
  appDb: () => wiring.db,
  appBlobs: () => wiring.blobs,
  ensureStarted: () => {},
  shareUrl: (origin: string, token: string) => `${origin}/s/${token}`,
}));

const { POST } = await import("../app/api/share/route");
const { revealShare } = await import("../app/s/[token]/actions");

function memBlobs(): BlobStore {
  const map = new Map<string, Buffer>();
  return {
    put: (id, data) => void map.set(id, data),
    get: (id) => map.get(id)!,
    delete: (id) => void map.delete(id),
    list: () => [...map.keys()],
  };
}

let requestCount = 0;

function postShare(fields: Record<string, string>) {
  const form = new FormData();
  form.set("kind", "text");
  form.set("text", "lantern-orbit");
  for (const [name, value] of Object.entries(fields)) form.set(name, value);
  requestCount += 1;
  return POST(
    new NextRequest("http://localhost:3000/api/share", {
      method: "POST",
      body: form,
      headers: { "x-forwarded-for": `10.0.0.${requestCount}` },
    }),
  );
}

function storedShare() {
  return wiring.db!.prepare("SELECT max_accesses, expires_at, created_at, password_hash FROM shares").get() as {
    max_accesses: number;
    expires_at: number;
    created_at: number;
    password_hash: string | null;
  };
}

beforeEach(() => {
  wiring.db = openDb(":memory:");
  wiring.blobs = memBlobs();
});

describe("POST /api/share options", () => {
  it.each([
    [{ maxAccesses: "0" }, "maxAccesses must be an integer from 1 to 100"],
    [{ maxAccesses: "101" }, "maxAccesses must be an integer from 1 to 100"],
    [{ maxAccesses: "abc" }, "maxAccesses must be an integer from 1 to 100"],
    [{ ttlSeconds: "3599" }, "ttlSeconds must be an integer from 3600 to 31536000"],
    [{ ttlSeconds: "31536001" }, "ttlSeconds must be an integer from 3600 to 31536000"],
    [{ password: "seven-7" }, "Password must be 8 to 128 characters"],
  ])("rejects %o with 400", async (fields, error) => {
    const response = await postShare(fields);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error });
    expect(wiring.db!.prepare("SELECT COUNT(*) c FROM shares").get()).toEqual({ c: 0 });
  });

  it("defaults to one view and 24 hours", async () => {
    const response = await postShare({});
    expect(response.status).toBe(200);
    const share = storedShare();
    expect(share.max_accesses).toBe(1);
    expect(share.expires_at - share.created_at).toBe(DEFAULT_TTL_SECONDS * 1000);
    expect(share.password_hash).toBeNull();
  });

  it("creates a password protected share with the chosen limits", async () => {
    const response = await postShare({ maxAccesses: "100", ttlSeconds: "31536000", password: "heron-42" });
    expect(response.status).toBe(200);
    const { url } = (await response.json()) as { url: string };
    expect(tokenFromShareUrl(url)).not.toBeNull();
    const share = storedShare();
    expect(share.max_accesses).toBe(100);
    expect(share.expires_at - share.created_at).toBe(31_536_000_000);
    expect(share.password_hash).toMatch(/^scrypt\$/);
  });
});

describe("revealShare", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("maps every gate outcome to a serializable result", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_800_000_000_000);
    const { token } = await createShare(wiring.db!, wiring.blobs!, {
      kind: "text",
      content: Buffer.from("lantern-orbit"),
      mime: "text/plain",
      maxAccesses: 1,
      ttlSeconds: DEFAULT_TTL_SECONDS,
      password: "heron-42",
    });

    expect(await revealShare(token)).toEqual({ ok: false, status: "password-required" });
    expect(await revealShare(token, "wrong")).toEqual({
      ok: false,
      status: "wrong-password",
      retryAfterMs: LOCK_DURATION_MS,
    });
    expect(await revealShare(token, "heron-42")).toEqual({
      ok: false,
      status: "locked",
      retryAfterMs: LOCK_DURATION_MS,
    });
    vi.setSystemTime(1_800_000_000_000 + LOCK_DURATION_MS);
    expect(await revealShare(token, "heron-42")).toEqual({ ok: true, kind: "text", text: "lantern-orbit" });
    expect(await revealShare(token, "heron-42")).toEqual({ ok: false, status: 404 });
  });

  it("rejects a non-string or oversized password without checking, locking or consuming", async () => {
    const { token } = await createShare(wiring.db!, wiring.blobs!, {
      kind: "text",
      content: Buffer.from("lantern-orbit"),
      mime: "text/plain",
      maxAccesses: 1,
      ttlSeconds: DEFAULT_TTL_SECONDS,
      password: "heron-42",
    });
    expect(await revealShare(token, "x".repeat(129))).toEqual({ ok: false, status: 400 });
    expect(await revealShare(token, 42 as unknown as string)).toEqual({ ok: false, status: 400 });
    expect(wiring.db!.prepare("SELECT access_count, locked_until FROM shares").get()).toEqual({
      access_count: 0,
      locked_until: null,
    });
    expect(await revealShare(token, "heron-42")).toEqual({ ok: true, kind: "text", text: "lantern-orbit" });
  });
});
