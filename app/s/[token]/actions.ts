"use server";

import { headers } from "next/headers";
import { appDb, appBlobs, ensureStarted } from "@/lib/app";
import { consumeShare } from "@/lib/store";
import { MAX_PASSWORD_LENGTH } from "@/lib/share-options";
import { passwordAttemptLimiter, revealLimiter } from "@/lib/rate-limit";
import { clientIp } from "@/lib/client-ip";

/** Serializable result of a reveal, safe to return across the RSC boundary. */
export type RevealResult =
  | { ok: true; kind: "text"; text: string }
  | { ok: true; kind: "file"; filename: string; mime: string; base64: string }
  | { ok: false; status: "password-required" }
  | { ok: false; status: "wrong-password" | "locked" | "rate-limited"; retryAfterMs: number }
  | { ok: false; status: number };

/**
 * Consume a share. This is the ONLY place that consumes an access — it runs from
 * an explicit user action (a POST-backed Server Action), never from the page's
 * GET render, so link-preview bots and prefetchers can't burn a single-use link.
 */
export async function revealShare(token: string, password = ""): Promise<RevealResult> {
  if (typeof password !== "string" || password.length > MAX_PASSWORD_LENGTH) return { ok: false, status: 400 };
  ensureStarted();
  const ip = clientIp(await headers());
  const revealLimit = revealLimiter.check(ip);
  if (!revealLimit.allowed) return { ok: false, status: "rate-limited", retryAfterMs: revealLimit.retryAfterMs };
  if (password !== "") {
    const attemptLimit = passwordAttemptLimiter.check(ip);
    if (!attemptLimit.allowed) return { ok: false, status: "rate-limited", retryAfterMs: attemptLimit.retryAfterMs };
  }
  try {
    const outcome = await consumeShare(appDb(), appBlobs(), token, password, ip);
    if (outcome.status !== "opened") return { ok: false, ...outcome };
    const r = outcome.share;
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
