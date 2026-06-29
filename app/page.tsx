"use client";

import { useState } from "react";
import { FileDropzone } from "./file-dropzone";

type Kind = "text" | "file";

export default function CreatePage() {
  const [kind, setKind] = useState<Kind>("text");
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [expiry, setExpiry] = useState("");
  const [maxAccesses, setMaxAccesses] = useState("1");
  const [loading, setLoading] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setUrl(null);

    const form = new FormData();
    form.set("kind", kind);
    if (kind === "text") form.set("text", text);
    else if (file) form.set("file", file);
    if (expiry) form.set("expiresAt", String(new Date(expiry).getTime()));
    form.set("maxAccesses", maxAccesses);

    try {
      const res = await fetch("/api/share", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) setError(data.error ?? "Errore sconosciuto");
      else setUrl(data.url);
    } catch {
      setError("Impossibile contattare il server.");
    } finally {
      setLoading(false);
    }
  }

  async function copy() {
    if (!url) return;
    await navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center px-6 py-12">
      <h1 className="text-2xl font-semibold text-zinc-900">Condividi in sicurezza</h1>
      <p className="mt-1 text-sm text-zinc-600">
        Genera un link segreto e monouso. Il contenuto è cifrato: senza il link
        nemmeno il server può leggerlo.
      </p>

      <form
        onSubmit={submit}
        className="mt-6 space-y-5 rounded-xl border border-zinc-200 bg-white p-6 shadow-sm"
      >
        <div className="flex gap-2">
          {(["text", "file"] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              className={`flex-1 rounded-md border px-3 py-2 text-sm font-medium ${
                kind === k
                  ? "border-zinc-900 bg-zinc-900 text-white"
                  : "border-zinc-300 bg-white text-zinc-700"
              }`}
            >
              {k === "text" ? "Testo" : "File"}
            </button>
          ))}
        </div>

        {kind === "text" ? (
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={6}
            placeholder="Incolla qui il testo da condividere…"
            className="w-full rounded-md border border-zinc-300 p-3 text-sm"
          />
        ) : (
          <FileDropzone file={file} onChange={setFile} />
        )}

        <div className="grid grid-cols-2 gap-4">
          <label className="text-sm">
            <span className="text-zinc-700">Scadenza (opzionale)</span>
            <input
              type="datetime-local"
              value={expiry}
              onChange={(e) => setExpiry(e.target.value)}
              className="mt-1 w-full rounded-md border border-zinc-300 p-2 text-sm"
            />
          </label>
          <label className="text-sm">
            <span className="text-zinc-700">Accessi massimi</span>
            <select
              value={maxAccesses}
              onChange={(e) => setMaxAccesses(e.target.value)}
              className="mt-1 w-full rounded-md border border-zinc-300 p-2 text-sm"
            >
              <option value="1">1 (monouso)</option>
              <option value="2">2</option>
              <option value="3">3</option>
            </select>
          </label>
        </div>

        <button
          type="submit"
          disabled={loading || (kind === "file" && !file)}
          className="w-full rounded-md bg-zinc-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50"
        >
          {loading ? "Generazione…" : "Genera link"}
        </button>

        {error && <p className="text-sm text-red-600">{error}</p>}
      </form>

      {url && (
        <div className="mt-4 rounded-xl border border-green-200 bg-green-50 p-5">
          <p className="text-sm font-medium text-green-900">Link pronto</p>
          <p className="mt-1 text-xs text-green-800">
            Salvalo subito: viene mostrato una sola volta.
          </p>
          <div className="mt-3 flex gap-2">
            <input
              readOnly
              value={url}
              className="flex-1 rounded-md border border-green-300 bg-white p-2 font-mono text-xs"
            />
            <button
              onClick={copy}
              className="rounded-md bg-green-700 px-3 py-2 text-sm font-medium text-white hover:bg-green-600"
            >
              {copied ? "Copiato" : "Copia"}
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
