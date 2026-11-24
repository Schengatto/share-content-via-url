import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { openDb, type DB } from "../lib/db";
import type { BlobStore } from "../lib/blob-store";
import { createShare } from "../lib/store";
import {
  PASSWORD_ATTEMPT_LIMIT_PER_MINUTE,
  REVEAL_LIMIT_PER_MINUTE,
  REVOKE_LIMIT_PER_MINUTE,
} from "../lib/rate-limit";

const wiring = vi.hoisted(() => ({
  db: undefined as DB | undefined,
  blobs: undefined as BlobStore | undefined,
  ip: "10.9.0.1",
}));

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": wiring.ip }),
}));

vi.mock("../lib/app", () => ({
  appDb: () => wiring.db,
  appBlobs: () => wiring.blobs,
  ensureStarted: () => {},
  shareUrl: (origin: string, token: string) => `${origin}/s/${token}`,
}));

const { revealShare } = await import("../app/s/[token]/actions");
const { DELETE } = await import("../app/api/share/[token]/route");

function memBlobs(): BlobStore {
  const map = new Map<string, Buffer>();
  return {
    put: (id, data) => void map.set(id, data),
    get: (id) => map.get(id)!,
    delete: (id) => void map.delete(id),
    list: () => [...map.keys()],
  };
}

function newShare(password?: string) {
  return createShare(wiring.db!, wiring.blobs!, {
    kind: "text",
    content: Buffer.from("lantern-orbit"),
    mime: "text/plain",
    maxAccesses: 100,
    ttlSeconds: 3600,
    password,
  });
}

function deleteShare(token: string) {
  return DELETE(
    new NextRequest(`http://localhost:3000/api/share/${token}`, {
      method: "DELETE",
      headers: { "x-forwarded-for": wiring.ip, "x-revoke-token": "wrong" },
    }),
    { params: Promise.resolve({ token }) },
  );
}

beforeEach(() => {
  wiring.db = openDb(":memory:");
  wiring.blobs = memBlobs();
});

describe("reveal rate limit", () => {
  it("refuses reveals past the per-IP limit without consuming a view, and other IPs are unaffected", async () => {
    wiring.ip = "10.9.1.1";
    const { token } = await newShare();
    for (let attempt = 0; attempt < REVEAL_LIMIT_PER_MINUTE; attempt++) {
      expect(await revealShare(token)).toMatchObject({ ok: true });
    }
    const refused = await revealShare(token);
    expect(refused).toMatchObject({ ok: false, status: "rate-limited" });
    expect((refused as { retryAfterMs: number }).retryAfterMs).toBeGreaterThan(0);
    expect((refused as { retryAfterMs: number }).retryAfterMs).toBeLessThanOrEqual(60_000);
    expect(wiring.db!.prepare("SELECT access_count FROM shares").get()).toEqual({
      access_count: REVEAL_LIMIT_PER_MINUTE,
    });

    wiring.ip = "10.9.1.2";
    expect(await revealShare(token)).toMatchObject({ ok: true });
  });

  it("answers an unknown token like a known one once the limit is hit", async () => {
    wiring.ip = "10.9.2.1";
    const { token } = await newShare();
    for (let attempt = 0; attempt < REVEAL_LIMIT_PER_MINUTE; attempt++) await revealShare("u".repeat(43));
    const unknown = await revealShare("u".repeat(43));
    const known = await revealShare(token);
    expect(unknown).toMatchObject({ ok: false, status: "rate-limited" });
    expect(known).toMatchObject({ ok: false, status: "rate-limited" });
  });
});

describe("password attempt rate limit", () => {
  it("refuses password attempts past the per-IP limit and keeps other IPs working", async () => {
    wiring.ip = "10.9.3.1";
    const { token } = await newShare("heron-42");
    for (let attempt = 0; attempt < PASSWORD_ATTEMPT_LIMIT_PER_MINUTE; attempt++) {
      expect(await revealShare(token, "guess-wrong")).toMatchObject({ ok: false });
    }
    expect(await revealShare(token, "guess-wrong")).toMatchObject({ ok: false, status: "rate-limited" });

    wiring.ip = "10.9.3.2";
    expect(await revealShare(token, "guess-wrong")).toMatchObject({ ok: false, status: "locked" });
  });

  it("does not count a reveal without a password as a password attempt", async () => {
    wiring.ip = "10.9.4.1";
    const { token } = await newShare("heron-42");
    for (let attempt = 0; attempt < PASSWORD_ATTEMPT_LIMIT_PER_MINUTE + 1; attempt++) {
      expect(await revealShare(token)).toEqual({ ok: false, status: "password-required" });
    }
  });
});

describe("DELETE rate limit", () => {
  it("answers 429 with Retry-After past the per-IP limit and keeps other IPs working", async () => {
    wiring.ip = "10.9.5.1";
    const { token } = await newShare();
    for (let attempt = 0; attempt < REVOKE_LIMIT_PER_MINUTE; attempt++) {
      expect((await deleteShare(token)).status).toBe(404);
    }
    const refused = await deleteShare(token);
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ error: "Too many requests" });
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);

    wiring.ip = "10.9.5.2";
    expect((await deleteShare(token)).status).toBe(404);
  });

  it("answers an unknown share exactly like a known one once the limit is hit", async () => {
    wiring.ip = "10.9.6.1";
    const { token } = await newShare();
    for (let attempt = 0; attempt < REVOKE_LIMIT_PER_MINUTE; attempt++) await deleteShare("u".repeat(43));
    const unknown = await deleteShare("u".repeat(43));
    const known = await deleteShare(token);
    expect(unknown.status).toBe(known.status);
    expect(await unknown.json()).toEqual(await known.json());
  });
});
