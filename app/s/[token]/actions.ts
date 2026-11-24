"use server";

import { headers } from "next/headers";
import { appDb, appBlobs, ensureStarted } from "@/lib/app";
import { consumeE2eShare, consumeShare } from "@/lib/store";
import { E2E_FORMAT, fromBase64Url, isWellFormedKey } from "@/lib/e2e-crypto";
import { MAX_PASSWORD_LENGTH } from "@/lib/share-options";
import { passwordAttemptLimiter, revealLimiter } from "@/lib/rate-limit";
import { clientIp } from "@/lib/client-ip";

export type RevealFailure =
  | { ok: false; status: "password-required" }
  | { ok: false; status: "wrong-password" | "locked" | "rate-limited"; retryAfterMs: number }
  | { ok: false; status: number };

/** Serializable result of a reveal, safe to return across the RSC boundary. */
export type RevealResult =
  | { ok: true; kind: "text"; text: string }
  | { ok: true; kind: "file"; filename: string; mime: string; base64: string }
  | RevealFailure;

export type E2eRevealResult = { ok: true; format: "e2e-v1"; ciphertext: string; iv: string } | RevealFailure;

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

export async function revealE2eShare(linkId: string, linkProof: string, authKey = ""): Promise<E2eRevealResult> {
  ensureStarted();
  const ip = clientIp(await headers());
  const revealLimit = revealLimiter.check(ip);
  if (!revealLimit.allowed) return { ok: false, status: "rate-limited", retryAfterMs: revealLimit.retryAfterMs };
  if (authKey !== "") {
    const attemptLimit = passwordAttemptLimiter.check(ip);
    if (!attemptLimit.allowed) return { ok: false, status: "rate-limited", retryAfterMs: attemptLimit.retryAfterMs };
    if (!isWellFormedKey(authKey)) return { ok: false, status: 400 };
  }
  if (!isWellFormedKey(linkProof)) return { ok: false, status: 404 };
  try {
    const outcome = consumeE2eShare(
      appDb(),
      appBlobs(),
      linkId,
      Buffer.from(fromBase64Url(linkProof)),
      authKey ? Buffer.from(fromBase64Url(authKey)) : null,
      ip,
    );
    if (outcome.status !== "opened") return { ok: false, ...outcome };
    return {
      ok: true,
      format: E2E_FORMAT,
      ciphertext: outcome.ciphertext.toString("base64url"),
      iv: outcome.iv.toString("base64url"),
    };
  } catch (e) {
    return { ok: false, status: (e as { status?: number }).status ?? 500 };
  }
}
