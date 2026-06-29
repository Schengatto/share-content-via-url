"use client";

import { useCallback, useEffect, useRef } from "react";

/** Reconstructs the decrypted file from base64 and triggers a download. */
export function FileDownload({
  filename,
  mime,
  base64,
}: {
  filename: string;
  mime: string;
  base64: string;
}) {
  const download = useCallback(() => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const blob = new Blob([bytes], { type: mime });
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = filename;
    a.click();
    // Revoke after the browser has had a chance to start the download.
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  }, [base64, mime, filename]);

  // Auto-start the download once on mount (the ref guards against React
  // StrictMode's double effect invocation in development).
  const autoStarted = useRef(false);
  useEffect(() => {
    if (autoStarted.current) return;
    autoStarted.current = true;
    download();
  }, [download]);

  return (
    <div className="space-y-3">
      <p className="text-sm text-zinc-600">
        Il download di <span className="font-mono">{filename}</span> è iniziato.
      </p>
      <button
        type="button"
        onClick={download}
        className="inline-block rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700"
      >
        Scarica di nuovo
      </button>
    </div>
  );
}
