"use client";

import { useState } from "react";
import { BrandHeader } from "./brand-header";
import { FileDropzone } from "./file-dropzone";
import {
  DEFAULT_EXPIRY,
  EXPIRY_PRESETS,
  VIEW_OPTIONS,
  expiresAtFor,
  expirySummary,
  tokenFromShareUrl,
  viewsLabel,
  type ExpiryPresetId,
} from "@/lib/share-options";

type Kind = "text" | "file";

type CreatedLink = {
  url: string;
  views: string;
  expiry: ExpiryPresetId;
  kind: Kind;
};

const BUTTON =
  "inline-flex items-center justify-center gap-2.5 rounded-[10px] px-5 py-3.5 text-[15px] font-semibold transition active:translate-y-px disabled:opacity-50";
const PRIMARY = `${BUTTON} bg-amber text-amber-ink hover:brightness-105`;
const GHOST = `${BUTTON} border border-edge text-ink hover:border-dim`;
const OPTION_LABEL = "mb-2 block font-mono text-[11.5px] uppercase tracking-[0.06em] text-dim";
const SELECT = "w-full rounded-lg border border-edge bg-raise px-2.5 py-2 text-sm text-ink";

export default function CreatePage() {
  const [kind, setKind] = useState<Kind>("text");
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [expiry, setExpiry] = useState<ExpiryPresetId>(DEFAULT_EXPIRY);
  const [views, setViews] = useState<string>("1");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedLink | null>(null);

  const canSubmit = !loading && (kind === "text" ? text.trim() !== "" : file !== null);

  async function submit() {
    if (!canSubmit) return;
    setLoading(true);
    setError(null);

    const form = new FormData();
    form.set("kind", kind);
    if (kind === "text") form.set("text", text);
    else if (file) form.set("file", file);
    const expiresAt = expiresAtFor(expiry, Date.now());
    if (expiresAt !== null) form.set("expiresAt", String(expiresAt));
    form.set("maxAccesses", views);

    try {
      const res = await fetch("/api/share", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) setError(data.error ?? "Unknown error");
      else {
        setCreated({ url: data.url, views, expiry, kind });
        setText("");
        setFile(null);
      }
    } catch {
      setError("Could not reach the server.");
    } finally {
      setLoading(false);
    }
  }

  if (created) {
    return <LinkReady link={created} onReset={() => setCreated(null)} />;
  }

  return (
    <main className="mx-auto w-full max-w-[640px] px-5 py-16">
      <BrandHeader status="encrypted at rest" />
      <h1 className="mb-3.5 text-[clamp(30px,4.6vw,46px)] font-semibold leading-[1.06] tracking-[-0.03em]">
        Leave it in the drop.
        <br />
        <em className="not-italic text-amber">Read once</em>, then burned.
      </h1>
      <p className="mb-9 max-w-[46ch] text-dim">
        Encrypted with a key derived from the link itself. Without the link, the
        server cannot open what it stores.
      </p>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            submit();
          }
        }}
      >
        <div className="rounded-[14px] border border-edge bg-panel">
          <div className="flex border-b border-edge" role="tablist">
            {(["text", "file"] as const).map((option) => (
              <button
                key={option}
                type="button"
                role="tab"
                aria-selected={kind === option}
                onClick={() => setKind(option)}
                className={`-mb-px border-b-2 px-[18px] py-3.5 text-[13.5px] font-medium ${
                  kind === option ? "border-amber text-ink" : "border-transparent text-dim hover:text-ink"
                }`}
              >
                {option === "text" ? "Text" : "File"}
              </button>
            ))}
          </div>

          {kind === "text" ? (
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={7}
              aria-label="Secret text"
              placeholder="Paste an API key, a password, a recovery phrase…"
              className="block min-h-[190px] w-full resize-y bg-transparent p-[18px] font-mono text-sm leading-[1.65] text-ink outline-none placeholder:text-faint"
            />
          ) : (
            <FileDropzone file={file} onChange={setFile} />
          )}

          <div className="grid grid-cols-2 border-t border-edge">
            <label className="px-[18px] py-3.5">
              <span className={OPTION_LABEL}>Burn after</span>
              <select value={views} onChange={(e) => setViews(e.target.value)} className={SELECT}>
                {VIEW_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {viewsLabel(option)}
                  </option>
                ))}
              </select>
            </label>
            <label className="border-l border-edge px-[18px] py-3.5">
              <span className={OPTION_LABEL}>Or at</span>
              <select
                value={expiry}
                onChange={(e) => setExpiry(e.target.value as ExpiryPresetId)}
                className={SELECT}
              >
                {EXPIRY_PRESETS.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>

        <button type="submit" disabled={!canSubmit} className={`${PRIMARY} mt-[18px] w-full`}>
          {loading ? "Sealing…" : "Seal and create link"}
          <span className="rounded bg-black/15 px-1.5 py-0.5 font-mono text-[11px] font-normal">
            Ctrl ↵
          </span>
        </button>

        {error && (
          <p role="alert" className="mt-3.5 text-sm text-ember">
            {error}
          </p>
        )}
        <p className="mt-3.5 text-[13px] text-dim">
          Sent over HTTPS and encrypted before it touches the disk.
        </p>
      </form>
    </main>
  );
}

function LinkReady({ link, onReset }: { link: CreatedLink; onReset: () => void }) {
  const [copied, setCopied] = useState(false);
  const [burn, setBurn] = useState<"idle" | "burning" | "burned" | "failed">("idle");

  async function copy() {
    await navigator.clipboard.writeText(link.url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  async function burnNow() {
    const token = tokenFromShareUrl(link.url);
    if (!token) return;
    setBurn("burning");
    const res = await fetch(`/api/share/${token}`, { method: "DELETE" }).catch(() => null);
    setBurn(res && (res.ok || res.status === 404) ? "burned" : "failed");
  }

  const burned = burn === "burned";
  const summary = [
    { label: "Views", value: viewsLabel(link.views) },
    { label: "Expires", value: expirySummary(link.expiry) },
    { label: "Content", value: link.kind === "text" ? "Text" : "File" },
  ];

  return (
    <main className="mx-auto w-full max-w-[640px] px-5 py-16">
      <BrandHeader status={burned ? "burned" : "sealed"} tone={burned ? "burned" : "live"} />
      <h1 className="mb-3.5 text-[clamp(30px,4.6vw,46px)] font-semibold leading-[1.06] tracking-[-0.03em]">
        {burned ? (
          "Burned. The link no longer works."
        ) : (
          <>
            Sealed. Copy the link <em className="not-italic text-amber">now</em>.
          </>
        )}
      </h1>
      <p className="mb-9 max-w-[46ch] text-dim">
        {burned
          ? "The content has been deleted from the server."
          : "We cannot show it again: we only keep a hash of it."}
      </p>

      <div className={`rounded-[14px] border border-edge bg-panel ${burned ? "opacity-50" : ""}`}>
        <div className="flex items-center gap-2.5 py-2 pl-[18px] pr-2">
          <code className="flex-1 truncate font-mono text-[13.5px] text-amber">{link.url}</code>
          <button type="button" onClick={copy} disabled={burned} className={`${PRIMARY} px-4 py-2.5`}>
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <dl className="grid grid-cols-3 gap-px overflow-hidden rounded-b-[14px] border-t border-edge bg-edge">
          {summary.map((item) => (
            <div key={item.label} className="bg-panel px-[18px] py-3.5">
              <dt className="font-mono text-[11px] uppercase tracking-[0.06em] text-dim">{item.label}</dt>
              <dd className="font-medium">{item.value}</dd>
            </div>
          ))}
        </dl>
      </div>

      <div className="mt-[18px] flex flex-wrap gap-2.5">
        <button type="button" onClick={onReset} className={GHOST}>
          New secret
        </button>
        {!burned && (
          <button
            type="button"
            onClick={burnNow}
            disabled={burn === "burning"}
            className={`${GHOST} text-ember`}
          >
            {burn === "burning" ? "Burning…" : "Burn it now"}
          </button>
        )}
      </div>
      {burn === "failed" && (
        <p role="alert" className="mt-3.5 text-sm text-ember">
          Could not burn the link. Try again.
        </p>
      )}
    </main>
  );
}
