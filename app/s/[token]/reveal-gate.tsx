"use client";

import Link from "next/link";
import { useEffect, useState, useSyncExternalStore } from "react";
import { BrandHeader } from "../../brand-header";
import { COMPACT_PRIMARY_BUTTON, GHOST_BUTTON, LOCKED_BUTTON, PRIMARY_BUTTON } from "../../buttons";
import { FIELD_LABEL, TEXT_INPUT } from "../../fields";
import { decryptText, deriveRevealProofs, isWellFormedKey } from "@/lib/e2e-crypto";
import { formatCountdown } from "@/lib/share-options";
import { FileDownload } from "./file-download";
import { revealE2eShare, revealShare, type RevealResult } from "./actions";

type E2eParameters = { salt: string; kdfIterations: number };

type GateResult = RevealResult | { ok: false; status: "undecryptable" };

function subscribeToHashChange(onHashChange: () => void) {
  window.addEventListener("hashchange", onHashChange);
  return () => window.removeEventListener("hashchange", onHashChange);
}

function readFragment(): string | null {
  return window.location.hash.slice(1);
}

function readServerFragment(): string | null {
  return null;
}

async function openE2eShare(
  token: string,
  e2e: E2eParameters,
  fragmentKey: string,
  password: string,
): Promise<GateResult> {
  const { linkProof, authKey, encKey } = await deriveRevealProofs(fragmentKey, e2e.salt, e2e.kdfIterations, password);
  const sealed = await revealE2eShare(token, linkProof, authKey);
  if (!sealed.ok) return sealed;
  try {
    return { ok: true, kind: "text", text: await decryptText(encKey, sealed.ciphertext, sealed.iv) };
  } catch {
    return { ok: false, status: "undecryptable" };
  }
}

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
    <div className="envelope-flap relative overflow-hidden rounded-[14px] border border-edge bg-panel px-6 pb-7 pt-10 text-center sm:px-9 sm:pb-9 sm:pt-12">
      {seal}
      <h1 className="mb-2.5 text-[22px] font-semibold leading-tight tracking-[-0.02em] sm:text-[26px]">{title}</h1>
      {children}
    </div>
  );
}

const LOCK_TICK_MS = 1000;

function sealedCopy(locked: boolean, passwordProtected: boolean) {
  if (locked) {
    return {
      title: "Locked for now.",
      intro: "Too many guesses are how secrets leak, so this one waits.",
    };
  }
  if (passwordProtected) {
    return {
      title: "Password required.",
      intro: "The sender protected this secret. Enter the password to open it. Opening it may use the last view.",
    };
  }
  return {
    title: "A sealed message is waiting",
    intro: "Breaking the seal may use the last view. After that, the content is deleted for good, so be ready to save it.",
  };
}

export function RevealGate({
  token,
  unavailableStatus,
  passwordProtected,
  initialLockRemainingMs,
  e2e,
}: {
  token: string;
  unavailableStatus: 404 | 410 | null;
  passwordProtected: boolean;
  initialLockRemainingMs: number;
  e2e: E2eParameters | null;
}) {
  const [phase, setPhase] = useState<"idle" | "loading" | "done">(unavailableStatus === null ? "idle" : "done");
  const [result, setResult] = useState<GateResult | null>(
    unavailableStatus === null ? null : { ok: false, status: unavailableStatus },
  );
  const [password, setPassword] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [lockMs, setLockMs] = useState(Math.max(0, initialLockRemainingMs));
  const [lockRemainingMs, setLockRemainingMs] = useState(Math.max(0, initialLockRemainingMs));
  const locked = lockMs > 0;
  const fragment = useSyncExternalStore(subscribeToHashChange, readFragment, readServerFragment);
  const awaitingFragment = e2e !== null && fragment === null;
  const incompleteLink = e2e !== null && fragment !== null && !isWellFormedKey(fragment);

  useEffect(() => {
    if (lockMs <= 0) return;
    const deadline = Date.now() + lockMs;
    const timer = setInterval(() => {
      const remainingMs = deadline - Date.now();
      if (remainingMs > 0) {
        setLockRemainingMs(remainingMs);
        return;
      }
      clearInterval(timer);
      setLockMs(0);
      setLockRemainingMs(0);
      setNotice("The lock ended. You can try again.");
    }, LOCK_TICK_MS);
    return () => clearInterval(timer);
  }, [lockMs]);

  async function reveal() {
    if (awaitingFragment || incompleteLink) return;
    if (passwordProtected && password === "") {
      setNotice("Enter the password.");
      return;
    }
    setPhase("loading");
    setNotice(null);
    let next: GateResult;
    try {
      next =
        e2e === null || fragment === null
          ? await revealShare(token, password)
          : await openE2eShare(token, e2e, fragment, password);
    } catch {
      setNotice("Could not open the secret. Reload and try again.");
      setPhase("idle");
      return;
    }
    if (!next.ok && next.status === "rate-limited") {
      setNotice(`Too many attempts. Try again in ${Math.ceil(next.retryAfterMs / 1000)} seconds.`);
      setPhase("idle");
      return;
    }
    if (!next.ok && next.status === "wrong-password" && next.retryAfterMs === 0) {
      setPassword("");
      setNotice("Wrong password. Try again.");
      setPhase("idle");
      return;
    }
    if (!next.ok && (next.status === "wrong-password" || next.status === "locked")) {
      setPassword("");
      setLockMs(next.retryAfterMs);
      setLockRemainingMs(next.retryAfterMs);
      setPhase("idle");
      return;
    }
    if (!next.ok && next.status === "password-required") {
      setNotice("Enter the password.");
      setPhase("idle");
      return;
    }
    if (e2e !== null && next.ok) {
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    }
    setResult(next);
    setPhase("done");
  }

  if (phase !== "done") {
    if (incompleteLink) {
      return (
        <>
          <BrandHeader status="incomplete" tone="empty" />
          <Envelope
            title="This link is incomplete."
            seal={
              <div className="relative mx-auto mb-[26px] grid h-16 w-16 place-items-center rounded-full bg-edge text-dim">
                <EmptyIcon />
              </div>
            }
          >
            <p className="mx-auto max-w-[40ch] text-dim">
              Ask the sender for the full link, including everything after the #.
            </p>
          </Envelope>
        </>
      );
    }
    const copy = sealedCopy(locked, passwordProtected);
    const loadingLabel = passwordProtected ? "Unlocking…" : "Breaking the seal…";
    return (
      <>
        <BrandHeader status={locked ? "locked" : "sealed"} tone={locked ? "burned" : "live"} />
        <Envelope
          title={copy.title}
          seal={
            <div className="wax-seal relative mx-auto mb-[26px] grid h-16 w-16 place-items-center rounded-full text-amber-ink">
              <LockIcon />
            </div>
          }
        >
          <p className="mx-auto mb-7 max-w-[40ch] text-dim">{copy.intro}</p>
          {locked && (
            <div className="mb-7">
              <div
                role="timer"
                className="font-mono text-[44px] font-medium leading-none tracking-[-0.03em] tabular-nums text-ember"
              >
                {formatCountdown(lockRemainingMs)}
              </div>
              <p className="mx-auto mt-3.5 max-w-[44ch] text-dim">
                Wrong password. The secret opens again when the timer ends. This attempt did not use a view.
              </p>
            </div>
          )}
          {passwordProtected ? (
            <form
              noValidate
              onSubmit={(e) => {
                e.preventDefault();
                reveal();
              }}
              className="mx-auto max-w-[360px] text-left"
            >
              <label htmlFor="unlock-password" className={`mb-2 block ${FIELD_LABEL}`}>
                Password
              </label>
              <input
                id="unlock-password"
                type="password"
                autoComplete="off"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  setNotice(null);
                }}
                disabled={locked || phase === "loading"}
                className={`w-full ${TEXT_INPUT}`}
              />
              {notice && (
                <p role="alert" className="mt-2.5 text-[13px] text-ember">
                  {notice}
                </p>
              )}
              <button
                type="submit"
                disabled={locked || phase === "loading" || awaitingFragment}
                className={`${locked ? LOCKED_BUTTON : PRIMARY_BUTTON} mt-4 w-full`}
              >
                {locked ? "Locked" : phase === "loading" ? "Unlocking…" : "Unlock secret"}
              </button>
            </form>
          ) : (
            <button
              type="button"
              onClick={reveal}
              disabled={phase === "loading" || awaitingFragment}
              className={`${PRIMARY_BUTTON} w-full sm:w-auto`}
            >
              {phase === "loading" ? loadingLabel : "Break the seal"}
            </button>
          )}
        </Envelope>
      </>
    );
  }

  if (!result || !result.ok) {
    const status = result?.status ?? 500;
    const message =
      status === "undecryptable"
        ? "This share could not be decrypted. The data may have been altered."
        : status === 404
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
          <Link
            href="/"
            className={`${GHOST_BUTTON} w-full sm:w-auto`}
          >
            Create your own
          </Link>
        </Envelope>
      </>
    );
  }

  return (
    <>
      <BrandHeader status="opened" tone="burned" />
      <div className="rounded-[14px] border border-edge bg-panel">
        {result.kind === "text" ? (
          <pre className="whitespace-pre-wrap break-words p-4 font-mono sm:p-[22px] text-sm leading-[1.7]">
            {result.text}
          </pre>
        ) : (
          <div className="p-4 sm:p-[22px]">
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
    <div className="flex items-center justify-between gap-4 border-t border-edge py-2 pl-4 pr-2 text-[13px] leading-snug text-ember sm:pl-[18px]">
      <span>This page may be the only copy left. Save it now.</span>
      {text !== null && (
        <button
          type="button"
          onClick={copy}
          className={COMPACT_PRIMARY_BUTTON}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      )}
    </div>
  );
}
