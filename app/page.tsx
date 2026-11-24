"use client";

import { useState } from "react";
import { BrandHeader } from "./brand-header";
import { COMPACT_PRIMARY_BUTTON, DANGER_BUTTON, GHOST_BUTTON, PRIMARY_BUTTON } from "./buttons";
import { FIELD_LABEL, TEXT_INPUT } from "./fields";
import { FileDropzone } from "./file-dropzone";
import {
  DEFAULT_TTL_STOP_INDEX,
  DEFAULT_VIEWS,
  LOCK_DURATION_LABEL,
  MAX_PASSWORD_LENGTH,
  MAX_VIEWS,
  MIN_PASSWORD_LENGTH,
  MIN_VIEWS,
  TTL_STOPS,
  tokenFromShareUrl,
  viewsLabel,
} from "@/lib/share-options";

type Kind = "text" | "file";

type CreatedLink = {
  url: string;
  views: number;
  expiryLabel: string;
  kind: Kind;
};

type ScaleMark = { label: string; at: number };

const PAGE = "mx-auto w-full max-w-[640px] px-5 pb-4 pt-4";
const HEADLINE = "mb-3.5 text-[clamp(28px,3.6vw,36px)] [@media(max-height:740px)]:text-[28px] font-semibold leading-[1.06] tracking-[-0.03em]";
const LEAD = "mb-4 max-w-[46ch] text-dim";
const OPTION = "px-4 py-3 sm:px-[18px]";
const OPTION_HEAD = "mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1";
const FOOT = "text-[13px] text-dim";
const FOOT_LINK =
  "text-ink underline decoration-edge-strong underline-offset-[3px] transition-colors hover:decoration-amber focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber";
const VIEW_SCALE: ScaleMark[] = [
  { label: String(MIN_VIEWS), at: 0 },
  { label: "50", at: (50 - MIN_VIEWS) / (MAX_VIEWS - MIN_VIEWS) },
  { label: String(MAX_VIEWS), at: 1 },
];
const TTL_SCALE: ScaleMark[] = [
  { label: "1h", at: 0 },
  { label: TTL_STOPS[TTL_STOPS.length - 1].label, at: 1 },
];

function scaleMarkPosition(at: number): string {
  if (at === 0) return "left-0";
  if (at === 1) return "right-0";
  return "range-scale-stop";
}

function RangeOption({
  id,
  label,
  min,
  max,
  value,
  valueText,
  marks,
  onChange,
}: {
  id: string;
  label: string;
  min: number;
  max: number;
  value: number;
  valueText: string;
  marks: ScaleMark[];
  onChange: (value: number) => void;
}) {
  return (
    <div className={OPTION}>
      <div className={OPTION_HEAD}>
        <label htmlFor={id} className={FIELD_LABEL}>
          {label}
        </label>
        <output htmlFor={id} className="font-mono text-sm font-medium tabular-nums text-ink">
          {valueText}
        </output>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={1}
        value={value}
        aria-valuetext={valueText}
        onChange={(e) => onChange(Number(e.target.value))}
        className="range-slider"
        style={{ "--fill": (value - min) / (max - min) } as React.CSSProperties}
      />
      <div aria-hidden="true" className="relative mt-1 h-4 font-mono text-[11px] text-dim">
        {marks.map((mark) => (
          <span
            key={mark.label}
            className={`absolute top-0 whitespace-nowrap ${scaleMarkPosition(mark.at)}`}
            style={{ "--at": mark.at } as React.CSSProperties}
          >
            {mark.label}
          </span>
        ))}
      </div>
    </div>
  );
}

export default function CreatePage() {
  const [kind, setKind] = useState<Kind>("text");
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [ttlStopIndex, setTtlStopIndex] = useState(DEFAULT_TTL_STOP_INDEX);
  const [views, setViews] = useState(DEFAULT_VIEWS);
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedLink | null>(null);

  const canSubmit = !loading && (kind === "text" ? text.trim() !== "" : file !== null);
  const ttlStop = TTL_STOPS[ttlStopIndex];

  async function submit() {
    if (!canSubmit) return;
    setLoading(true);
    setError(null);

    const form = new FormData();
    form.set("kind", kind);
    if (kind === "text") form.set("text", text);
    else if (file) form.set("file", file);
    form.set("maxAccesses", String(views));
    form.set("ttlSeconds", String(ttlStop.seconds));
    if (password !== "") form.set("password", password);

    try {
      const res = await fetch("/api/share", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) setError(data.error ?? "Unknown error");
      else {
        setCreated({ url: data.url, views, expiryLabel: ttlStop.label, kind });
        setText("");
        setFile(null);
        setPassword("");
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
    <main className={PAGE}>
      <BrandHeader status="encrypted at rest" className="mb-4" />
      <h1 className={HEADLINE}>
        Leave it in the drop.
        <br />
        <em className="not-italic text-amber">Read once</em>, then burned.
      </h1>
      <p className={LEAD}>
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
                className={`-mb-px flex-1 border-b-2 px-[18px] py-3.5 sm:flex-none text-[13.5px] font-medium ${
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
              rows={2}
              aria-label="Secret text"
              placeholder="Paste an API key, a password, a recovery phrase…"
              className="block min-h-[72px] w-full resize-y bg-transparent px-[18px] py-4 font-mono text-sm leading-[1.65] text-ink outline-none placeholder:text-faint"
            />
          ) : (
            <FileDropzone file={file} onChange={setFile} />
          )}

          <div className="grid grid-cols-1 border-t border-edge min-[560px]:grid-cols-2">
            <RangeOption
              id="share-views"
              label="Burn after"
              min={MIN_VIEWS}
              max={MAX_VIEWS}
              value={views}
              valueText={viewsLabel(views)}
              marks={VIEW_SCALE}
              onChange={setViews}
            />
            <div className="border-t border-edge min-[560px]:border-l min-[560px]:border-t-0">
              <RangeOption
                id="share-ttl"
                label="Or at"
                min={0}
                max={TTL_STOPS.length - 1}
                value={ttlStopIndex}
                valueText={ttlStop.label}
                marks={TTL_SCALE}
                onChange={setTtlStopIndex}
              />
            </div>
          </div>

          <div className={`border-t border-edge ${OPTION}`}>
            <div className={OPTION_HEAD}>
              <label htmlFor="share-password" className={FIELD_LABEL}>
                Password
                <span className="ml-1.5 normal-case tracking-normal text-faint">optional</span>
              </label>
              <span id="share-password-hint" className="text-[12.5px] text-dim">
                A wrong password locks it for {LOCK_DURATION_LABEL}.
              </span>
            </div>
            <div className="flex gap-2">
              <input
                id="share-password"
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                placeholder="No password"
                minLength={MIN_PASSWORD_LENGTH}
                maxLength={MAX_PASSWORD_LENGTH}
                aria-describedby="share-password-hint"
                className={TEXT_INPUT}
              />
              <button
                type="button"
                aria-pressed={showPassword}
                onClick={() => setShowPassword(!showPassword)}
                className="rounded-lg border border-edge bg-raise px-3.5 text-[13px] font-medium text-dim transition-colors hover:border-edge-strong hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-amber"
              >
                {showPassword ? "Hide" : "Show"}
              </button>
            </div>
          </div>

          <p
            aria-live="polite"
            className="rounded-b-[14px] border-t border-edge bg-night px-4 py-2.5 text-[13.5px] text-dim sm:px-[18px]"
          >
            Burns after <b className="font-medium text-ink">{viewsLabel(views)}</b> or in{" "}
            <b className="font-medium text-ink">{ttlStop.label}</b>, whichever comes first.
            {password !== "" && " Password protected."}
          </p>
        </div>

        <button type="submit" disabled={!canSubmit} className={`${PRIMARY_BUTTON} mt-3.5 w-full`}>
          {loading ? "Sealing…" : "Seal and create link"}
          <span className="hidden rounded bg-black/15 px-1.5 py-0.5 font-mono text-[11px] font-normal sm:inline">
            Ctrl ↵
          </span>
        </button>

        {error && (
          <p role="alert" className="mt-3.5 text-sm text-ember">
            {error}
          </p>
        )}
        <p className={`mt-3 ${FOOT}`}>Sent over HTTPS and encrypted before it touches the disk.</p>
        <p className={`mt-1 ${FOOT}`}>
          <a
            href="https://github.com/Schengatto/share-content-via-url"
            target="_blank"
            rel="noopener noreferrer"
            className={FOOT_LINK}
          >
            Open source
          </a>{" "}
          and secure by design. Built by{" "}
          <a href="https://enricoschintu.com" target="_blank" rel="noopener noreferrer" className={FOOT_LINK}>
            Enrico Schintu
          </a>
          .
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
    { label: "Expires", value: `in ${link.expiryLabel}` },
    { label: "Content", value: link.kind === "text" ? "Text" : "File" },
  ];

  return (
    <main className={PAGE}>
      <BrandHeader status={burned ? "burned" : "sealed"} tone={burned ? "burned" : "live"} />
      <h1 className={HEADLINE}>
        {burned ? (
          "Burned. The link no longer works."
        ) : (
          <>
            Sealed. Copy the link <em className="not-italic text-amber">now</em>.
          </>
        )}
      </h1>
      <p className={LEAD}>
        {burned
          ? "The content has been deleted from the server."
          : "We cannot show it again: we only keep a hash of it."}
      </p>

      <div className={`rounded-[14px] border border-edge bg-panel ${burned ? "opacity-50" : ""}`}>
        <div className="flex items-center gap-2.5 py-2 pl-4 pr-2 sm:pl-[18px]">
          <code className="flex-1 truncate font-mono text-[13.5px] text-amber">{link.url}</code>
          <button type="button" onClick={copy} disabled={burned} className={COMPACT_PRIMARY_BUTTON}>
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <dl className="grid grid-cols-3 gap-px overflow-hidden rounded-b-[14px] border-t border-edge bg-edge">
          {summary.map((item) => (
            <div key={item.label} className="min-w-0 bg-panel px-3.5 py-3.5 sm:px-[18px]">
              <dt className="font-mono text-[11px] uppercase tracking-[0.06em] text-dim">{item.label}</dt>
              <dd className="font-medium">{item.value}</dd>
            </div>
          ))}
        </dl>
      </div>

      <div className="mt-[18px] flex gap-2.5">
        <button type="button" onClick={onReset} className={`${GHOST_BUTTON} flex-1`}>
          New secret
        </button>
        {!burned && (
          <button
            type="button"
            onClick={burnNow}
            disabled={burn === "burning"}
            className={`${DANGER_BUTTON} flex-1`}
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
