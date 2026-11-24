import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { openDb, type DB } from "../lib/db";
import type { BlobStore } from "../lib/blob-store";
import { tokenFromShareUrl } from "../lib/share-options";

const wiring = vi.hoisted(() => ({ db: undefined as DB | undefined, blobs: undefined as BlobStore | undefined }));

vi.mock("../lib/app", () => ({
  appDb: () => wiring.db,
  appBlobs: () => wiring.blobs,
  ensureStarted: () => {},
  shareUrl: (origin: string, token: string) => `${origin}/s/${token}`,
}));

const { POST } = await import("../app/api/share/route");
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

let requestCount = 0;

async function createViaApi() {
  const form = new FormData();
  form.set("kind", "text");
  form.set("text", "lantern-orbit");
  requestCount += 1;
  const response = await POST(
    new NextRequest("http://localhost:3000/api/share", {
      method: "POST",
      body: form,
      headers: { "x-forwarded-for": `10.1.0.${requestCount}` },
    }),
  );
  const { url, revokeToken } = (await response.json()) as { url: string; revokeToken: string };
  return { token: tokenFromShareUrl(url)!, revokeToken };
}

function deleteShare(token: string, revokeToken?: string) {
  return DELETE(
    new NextRequest(`http://localhost:3000/api/share/${token}`, {
      method: "DELETE",
      headers: revokeToken === undefined ? {} : { "x-revoke-token": revokeToken },
    }),
    { params: Promise.resolve({ token }) },
  );
}

function shareCount() {
  return (wiring.db!.prepare("SELECT COUNT(*) c FROM shares").get() as { c: number }).c;
}

beforeEach(() => {
  wiring.db = openDb(":memory:");
  wiring.blobs = memBlobs();
});

describe("revoke token over the API", () => {
  it("returns a revoke token only in the creation response", async () => {
    const { token, revokeToken } = await createViaApi();
    expect(revokeToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(revokeToken).not.toBe(token);
  });

  it("refuses DELETE with only the link, with 404 and the share kept", async () => {
    const { token } = await createViaApi();
    const response = await deleteShare(token);
    expect(response.status).toBe(404);
    expect(shareCount()).toBe(1);
  });

  it("refuses DELETE with a wrong revoke token", async () => {
    const { token } = await createViaApi();
    const response = await deleteShare(token, "x".repeat(43));
    expect(response.status).toBe(404);
    expect(shareCount()).toBe(1);
  });

  it("gives the same answer for an unknown share and a refused revoke", async () => {
    const { token } = await createViaApi();
    const refused = await deleteShare(token, "x".repeat(43));
    const unknown = await deleteShare("y".repeat(43), "x".repeat(43));
    expect(refused.status).toBe(unknown.status);
    expect(await refused.json()).toEqual(await unknown.json());
  });

  it("revokes with the revoke token from the creation response", async () => {
    const { token, revokeToken } = await createViaApi();
    const response = await deleteShare(token, revokeToken);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ revoked: true });
    expect(shareCount()).toBe(0);
  });

  it("lets a legacy share without a revoke token hash be revoked by the link alone", async () => {
    const { token } = await createViaApi();
    wiring.db!.prepare("UPDATE shares SET revoke_token_hash = NULL").run();
    const response = await deleteShare(token);
    expect(response.status).toBe(200);
    expect(shareCount()).toBe(0);
  });
});
