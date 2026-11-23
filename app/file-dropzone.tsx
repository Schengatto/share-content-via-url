"use client";

import { useId, useRef, useState } from "react";
import {
  ACCEPT,
  MAX_SIZE,
  SUPPORTED_FILE_GROUPS,
  formatBytes,
  isSupportedFile,
} from "@/lib/file-support";

/** Styled drag-and-drop file picker with client-side type/size validation. */
export function FileDropzone({
  file,
  onChange,
}: {
  file: File | null;
  onChange: (file: File | null) => void;
}) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function accept(candidate: File | undefined) {
    if (!candidate) return;
    if (!isSupportedFile(candidate)) {
      setError("Unsupported file type.");
      return;
    }
    if (candidate.size > MAX_SIZE) {
      setError(`File too large (max ${formatBytes(MAX_SIZE)}).`);
      return;
    }
    setError(null);
    onChange(candidate);
  }

  function clear() {
    setError(null);
    onChange(null);
    if (inputRef.current) inputRef.current.value = "";
  }

  return (
    <div className="space-y-3 p-[18px]">
      <input
        ref={inputRef}
        id={inputId}
        type="file"
        accept={ACCEPT}
        className="sr-only"
        onChange={(e) => accept(e.target.files?.[0])}
      />

      {file ? (
        <div className="flex items-center gap-3 rounded-[10px] border border-edge bg-raise p-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-amber text-amber-ink">
            <FileIcon />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-ink">
              {file.name}
            </p>
            <p className="font-mono text-xs text-dim">{formatBytes(file.size)}</p>
          </div>
          <button
            type="button"
            onClick={clear}
            aria-label="Remove file"
            className="grid h-10 w-10 shrink-0 place-items-center rounded-md text-dim hover:bg-edge hover:text-ink"
          >
            <XIcon />
          </button>
        </div>
      ) : (
        <label
          htmlFor={inputId}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            accept(e.dataTransfer.files?.[0]);
          }}
          className={`flex cursor-pointer items-center justify-center gap-3 rounded-[10px] border-[1.5px] border-dashed px-5 py-6 text-left transition-colors ${
            dragOver
              ? "border-amber bg-amber/5"
              : "border-edge-strong hover:border-dim"
          }`}
        >
          <span className="text-dim">
            <UploadIcon />
          </span>
          <span className="flex flex-col text-sm text-dim">
            <span>
              <span className="font-medium text-ink">Drop a file</span> or{" "}
              <span className="underline underline-offset-4">browse</span>
            </span>
            <span className="font-mono text-xs">max {formatBytes(MAX_SIZE)}</span>
          </span>
        </label>
      )}

      {error && <p className="text-sm text-ember">{error}</p>}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 pt-0.5">
        <span className="font-mono text-[11px] uppercase tracking-wider text-dim">Supported</span>
        {SUPPORTED_FILE_GROUPS.flatMap((group) => group.items).map((type) => (
          <span
            key={type.mime}
            className="rounded bg-raise px-1.5 py-0.5 font-mono text-[11px] text-dim"
          >
            {type.label}
          </span>
        ))}
      </div>
    </div>
  );
}

function UploadIcon() {
  return (
    <svg
      width="28"
      height="28"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 16V4m0 0L8 8m4-4 4 4" />
      <path d="M4 14v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}
