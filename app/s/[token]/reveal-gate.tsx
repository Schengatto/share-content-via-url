"use client";

import { useState } from "react";
import { BrandHeader } from "../../brand-header";
import { FileDownload } from "./file-download";
import { revealShare, type RevealResult } from "./actions";

const PRIMARY =
  "inline-flex items-center justify-center gap-2.5 rounded-[10px] bg-amber px-5 py-3.5 text-[15px] font-semibold text-amber-ink transition hover:brightness-105 active:translate-y-px disabled:opacity-50";

function LockIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

function EmptyIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M8 8l8 8" />
    </svg>
  );
}

function Envelope({
  seal,
  title,
  children,
}: {
  seal: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="envelope-flap relative overflow-hidden rounded-[14px] border border-edge bg-panel px-9 pb-9 pt-12 text-center">
      {seal}
      <h1 className="mb-2.5 text-[26px] font-semibold tracking-[-0.02em]">{title}</h1>
      {children}
    </div>
  );
}

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
        <BrandHeader status="sealed" />
        <Envelope
          title="A sealed message is waiting"
          seal={
            <div className="wax-seal relative mx-auto mb-[26px] grid h-16 w-16 place-items-center rounded-full text-amber-ink">
              <LockIcon />
            </div>
          }
        >
          <p className="mx-auto mb-7 max-w-[40ch] text-dim">
            Breaking the seal may use the last view. After that, the content is
            deleted for good, so be ready to save it.
          </p>
          <button type="button" onClick={reveal} disabled={phase === "loading"} className={PRIMARY}>
            {phase === "loading" ? "Breaking the seal…" : "Break the seal"}
          </button>
        </Envelope>
      </>
    );
  }

  if (!result || !result.ok) {
    const status = result?.status ?? 500;
    const message =
      status === 404
        ? "This link does not exist or has already been used."
        : status === 410
          ? "This link has expired or has no views left."
          : "An error occurred while retrieving the content.";
    return (
      <>
        <BrandHeader status="empty" tone="empty" />
        <Envelope
          title="Nothing left in this drop"
          seal={
            <div className="relative mx-auto mb-[26px] grid h-16 w-16 place-items-center rounded-full bg-edge text-dim">
              <EmptyIcon />
            </div>
          }
        >
          <p className="mx-auto mb-7 max-w-[40ch] text-dim">
            {message} Ask the sender to seal a new one.
          </p>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-[10px] border border-edge px-5 py-3.5 text-[15px] font-semibold text-ink hover:border-dim"
          >
            Create your own
          </a>
        </Envelope>
      </>
    );
  }

  return (
    <>
      <BrandHeader status="opened" tone="burned" />
      <div className="rounded-[14px] border border-edge bg-panel">
        {result.kind === "text" ? (
          <pre className="whitespace-pre-wrap break-words p-[22px] font-mono text-sm leading-[1.7]">
            {result.text}
          </pre>
        ) : (
          <div className="p-[22px]">
            <FileDownload filename={result.filename} mime={result.mime} base64={result.base64} />
          </div>
        )}
        <RevealFooter text={result.kind === "text" ? result.text : null} />
      </div>
    </>
  );
}

function RevealFooter({ text }: { text: string | null }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    if (text === null) return;
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="flex items-center justify-between gap-4 border-t border-edge px-[18px] py-3 text-[13px] text-ember">
      <span>This page may be the only copy left. Save it now.</span>
      {text !== null && (
        <button
          type="button"
          onClick={copy}
          className="rounded-[10px] bg-amber px-3.5 py-2 text-sm font-semibold text-amber-ink hover:brightness-105"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      )}
    </div>
  );
}
