"use server";

import { appDb, appBlobs, ensureStarted } from "@/lib/app";
import { consumeShare } from "@/lib/store";

/** Serializable result of a reveal, safe to return across the RSC boundary. */
export type RevealResult =
  | { ok: true; kind: "text"; text: string }
  | { ok: true; kind: "file"; filename: string; mime: string; base64: string }
  | { ok: false; status: number };

/**
 * Consume a share. This is the ONLY place that consumes an access — it runs from
 * an explicit user action (a POST-backed Server Action), never from the page's
 * GET render, so link-preview bots and prefetchers can't burn a single-use link.
 */
export async function revealShare(token: string): Promise<RevealResult> {
  ensureStarted();
  try {
    const r = await consumeShare(appDb(), appBlobs(), token);
    if (r.kind === "text") {
      return { ok: true, kind: "text", text: r.content.toString("utf8") };
    }
    return {
      ok: true,
      kind: "file",
      filename: r.filename ?? "download",
      mime: r.mime,
      base64: r.content.toString("base64"),
    };
  } catch (e) {
    return { ok: false, status: (e as { status?: number }).status ?? 500 };
  }
}
