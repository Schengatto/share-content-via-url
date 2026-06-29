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
      setError("Tipo di file non supportato.");
      return;
    }
    if (candidate.size > MAX_SIZE) {
      setError(`File troppo grande (max ${formatBytes(MAX_SIZE)}).`);
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
    <div className="space-y-2">
      <input
        ref={inputRef}
        id={inputId}
        type="file"
        accept={ACCEPT}
        className="sr-only"
        onChange={(e) => accept(e.target.files?.[0])}
      />

      {file ? (
        <div className="flex items-center gap-3 rounded-lg border border-zinc-200 bg-zinc-50 p-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-zinc-900 text-white">
            <FileIcon />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-zinc-900">
              {file.name}
            </p>
            <p className="text-xs text-zinc-500">{formatBytes(file.size)}</p>
          </div>
          <button
            type="button"
            onClick={clear}
            aria-label="Rimuovi file"
            className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700"
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
          className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-6 py-8 text-center transition-colors ${
            dragOver
              ? "border-zinc-900 bg-zinc-50"
              : "border-zinc-300 bg-white hover:border-zinc-400 hover:bg-zinc-50"
          }`}
        >
          <span className="text-zinc-400">
            <UploadIcon />
          </span>
          <span className="text-sm text-zinc-700">
            <span className="font-medium text-zinc-900">Trascina un file</span>{" "}
            qui, oppure <span className="underline">sfoglia</span>
          </span>
          <span className="text-xs text-zinc-500">
            max {formatBytes(MAX_SIZE)}
          </span>
        </label>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 pt-0.5">
        <span className="text-xs font-medium text-zinc-500">Supportati:</span>
        {SUPPORTED_FILE_GROUPS.flatMap((group) => group.items).map((type) => (
          <span
            key={type.mime}
            className="rounded bg-zinc-100 px-1.5 py-0.5 text-[11px] font-medium text-zinc-600"
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
