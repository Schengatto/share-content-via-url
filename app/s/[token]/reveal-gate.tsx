"use client";

import { useState } from "react";
import { FileDownload } from "./file-download";
import { revealShare, type RevealResult } from "./actions";

/**
 * Requires an explicit click before consuming the share, so a plain GET to the
 * page (browser prefetch, chat/email link-preview bots, antivirus scanners)
 * never burns the one-time access. Consumption happens in the Server Action.
 */
export function RevealGate({ token }: { token: string }) {
  const [phase, setPhase] = useState<"idle" | "loading" | "done">("idle");
  const [result, setResult] = useState<RevealResult | null>(null);

  async function reveal() {
    setPhase("loading");
    setResult(await revealShare(token));
    setPhase("done");
  }

  if (phase !== "done") {
    return (
      <>
        <h1 className="text-xl font-semibold text-zinc-900">Shared content</h1>
        <p className="mt-2 text-sm text-zinc-600">
          This content is single-use: once revealed it may no longer be
          available. Open it only when you are ready to save it.
        </p>
        <button
          type="button"
          onClick={reveal}
          disabled={phase === "loading"}
          className="mt-4 inline-block rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50"
        >
          {phase === "loading" ? "Retrieving…" : "Reveal content"}
        </button>
      </>
    );
  }

  if (!result || !result.ok) {
    const status = result?.status ?? 500;
    const message =
      status === 404
        ? "This link does not exist or has already been used."
        : status === 410
          ? "This link has expired or has no accesses left."
          : "An error occurred while retrieving the content.";
    return (
      <>
        <h1 className="text-xl font-semibold text-zinc-900">Content not available</h1>
        <p className="mt-2 text-sm text-zinc-600">{message}</p>
      </>
    );
  }

  if (result.kind === "text") {
    // React escapes interpolated text, so it is never rendered as HTML.
    return (
      <>
        <h1 className="text-xl font-semibold text-zinc-900">Shared content</h1>
        <pre className="mt-4 whitespace-pre-wrap break-words rounded-md bg-zinc-50 p-4 text-sm text-zinc-800">
          {result.text}
        </pre>
      </>
    );
  }

  return (
    <>
      <h1 className="text-xl font-semibold text-zinc-900">Shared file</h1>
      <p className="mt-1 text-xs text-amber-600">
        Save the file now: the link may no longer be available after this visit.
      </p>
      <div className="mt-4">
        <FileDownload
          filename={result.filename}
          mime={result.mime}
          base64={result.base64}
        />
      </div>
    </>
  );
}
