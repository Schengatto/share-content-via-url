import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { openDb, type DB } from "../lib/db";
import type { BlobStore } from "../lib/blob-store";
import { createShare } from "../lib/store";
import { DEFAULT_TTL_SECONDS, LOCK_DURATION_MS, VISITOR_LOCK_FAILURES, tokenFromShareUrl } from "../lib/share-options";
import { E2E_FORMAT, deriveRevealProofs, encryptText, type E2eTextUpload } from "../lib/e2e-crypto";

const wiring = vi.hoisted(() => ({ db: undefined as DB | undefined, blobs: undefined as BlobStore | undefined }));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

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

const PLAINTEXT = "lantern-orbit";
const PASSWORD = "heron-42";

function postForm(form: FormData) {
  requestCount += 1;
  return POST(
    new NextRequest("http://localhost:3000/api/share", {
      method: "POST",
      body: form,
      headers: { "x-forwarded-for": `10.0.0.${requestCount}` },
    }),
  );
}

function buildE2eForm(upload: E2eTextUpload, fields: Record<string, string> = {}) {
  const form = new FormData();
  form.set("kind", "text");
  form.set("encryption", E2E_FORMAT);
  form.set("ciphertext", new Blob([upload.ciphertext]));
  form.set("iv", upload.iv);
  form.set("salt", upload.salt);
  form.set("kdfIterations", String(upload.kdfIterations));
  form.set("linkProofHash", upload.linkProofHash);
  if (upload.authHash !== null) form.set("authHash", upload.authHash);
  form.set("maxAccesses", "1");
  form.set("ttlSeconds", String(DEFAULT_TTL_SECONDS));
  for (const [name, value] of Object.entries(fields)) form.set(name, value);
  return form;
}

function postE2e(upload: E2eTextUpload, fields?: Record<string, string>) {
  return postForm(buildE2eForm(upload, fields));
}

function postFile(fields: Record<string, string>) {
  const form = new FormData();
  form.set("kind", "file");
  form.set("file", new File(["lantern-orbit"], "note.txt", { type: "text/plain" }));
  for (const [name, value] of Object.entries(fields)) form.set(name, value);
  return postForm(form);
}

function storedShare() {
  return wiring.db!
    .prepare("SELECT max_accesses, expires_at, created_at, password_hash, e2e_kdf_iterations, auth_hash FROM shares")
    .get() as {
    max_accesses: number;
    expires_at: number;
    created_at: number;
    password_hash: string | null;
    e2e_kdf_iterations: number;
    auth_hash: string | null;
  };
}

function shareCount() {
  return (wiring.db!.prepare("SELECT COUNT(*) c FROM shares").get() as { c: number }).c;
}

function bytesOf(value: unknown): Buffer {
  return Buffer.isBuffer(value) ? value : Buffer.from(String(value));
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
  ])("rejects text options %o with 400", async (fields, error) => {
    const response = await postE2e(await encryptText(PLAINTEXT), fields);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error });
    expect(shareCount()).toBe(0);
  });

  it("rejects a file password shorter than 8 characters with 400", async () => {
    const response = await postFile({ password: "seven-7" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Password must be 8 to 128 characters" });
    expect(shareCount()).toBe(0);
  });

  it("defaults to one view and 24 hours", async () => {
    const form = buildE2eForm(await encryptText(PLAINTEXT));
    form.delete("maxAccesses");
    form.delete("ttlSeconds");
    const response = await postForm(form);
    expect(response.status).toBe(200);
    const share = storedShare();
    expect(share.max_accesses).toBe(1);
    expect(share.expires_at - share.created_at).toBe(DEFAULT_TTL_SECONDS * 1000);
    expect(share.password_hash).toBeNull();
    expect(share.e2e_kdf_iterations).toBe(0);
    expect(share.auth_hash).toBeNull();
  });

  it("creates a password protected text share with the chosen limits", async () => {
    const upload = await encryptText(PLAINTEXT, PASSWORD);
    const response = await postE2e(upload, { maxAccesses: "100", ttlSeconds: "31536000" });
    expect(response.status).toBe(200);
    const { url } = (await response.json()) as { url: string };
    expect(tokenFromShareUrl(url)).not.toBeNull();
    const share = storedShare();
    expect(share.max_accesses).toBe(100);
    expect(share.expires_at - share.created_at).toBe(31_536_000_000);
    expect(share.password_hash).toBeNull();
    expect(share.e2e_kdf_iterations).toBe(upload.kdfIterations);
    expect(share.auth_hash).toBe(upload.authHash);
  });
});

describe("POST /api/share end-to-end text", () => {
  it("stores only the ciphertext and answers with the link id", async () => {
    const upload = await encryptText(PLAINTEXT, PASSWORD);
    const response = await postE2e(upload);
    expect(response.status).toBe(200);
    const { id, url, revokeToken } = (await response.json()) as { id: string; url: string; revokeToken: string };
    expect(id).toHaveLength(22);
    expect(url.endsWith(`/s/${id}`)).toBe(true);
    expect(revokeToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const row = wiring.db!.prepare("SELECT * FROM shares").get() as Record<string, unknown>;
    const storedBlob = wiring.blobs!.get(row.blob_path as string);
    expect(Buffer.compare(storedBlob, Buffer.from(upload.ciphertext))).toBe(0);

    const { linkProof, authKey } = await deriveRevealProofs(upload.fragmentKey, upload.salt, upload.kdfIterations, PASSWORD);
    const stored = Buffer.concat([...Object.values(row).map(bytesOf), storedBlob]);
    for (const secret of [PLAINTEXT, PASSWORD, upload.fragmentKey, linkProof, authKey]) {
      expect(stored.includes(secret)).toBe(false);
    }
  });

  it("builds a request without the plaintext, the password or the fragment key", async () => {
    const upload = await encryptText(PLAINTEXT, PASSWORD);
    for (const [, value] of buildE2eForm(upload).entries()) {
      const bytes = value instanceof Blob ? Buffer.from(await value.arrayBuffer()) : Buffer.from(value);
      for (const secret of [PLAINTEXT, PASSWORD, upload.fragmentKey]) {
        expect(bytes.includes(secret)).toBe(false);
      }
    }
  });

  it("rejects the legacy plaintext text request with 400", async () => {
    const form = new FormData();
    form.set("kind", "text");
    form.set("text", PLAINTEXT);
    const response = await postForm(form);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "This page is out of date. Reload it and try again." });
    expect(shareCount()).toBe(0);
  });

  it("rejects an end-to-end request without the ciphertext file", async () => {
    const form = buildE2eForm(await encryptText(PLAINTEXT));
    form.delete("ciphertext");
    expect((await postForm(form)).status).toBe(400);
    expect(shareCount()).toBe(0);
  });

  it("rejects a password-protected payload declaring zero KDF iterations", async () => {
    const response = await postE2e(await encryptText(PLAINTEXT, PASSWORD), { kdfIterations: "0" });
    expect(response.status).toBe(400);
    expect(shareCount()).toBe(0);
  });

  it("rejects a ciphertext shorter than 20 bytes", async () => {
    const upload = await encryptText(PLAINTEXT);
    const response = await postE2e({ ...upload, ciphertext: upload.ciphertext.slice(0, 19) });
    expect(response.status).toBe(400);
    expect(shareCount()).toBe(0);
  });

  it("rejects an iv that is not valid base64url", async () => {
    const response = await postE2e(await encryptText(PLAINTEXT), { iv: "not valid!" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid encrypted payload" });
    expect(shareCount()).toBe(0);
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
    for (let guess = 1; guess < VISITOR_LOCK_FAILURES; guess++) {
      expect(await revealShare(token, "wrong")).toEqual({ ok: false, status: "wrong-password", retryAfterMs: 0 });
    }
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
