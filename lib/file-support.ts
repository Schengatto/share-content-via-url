/**
 * Single source of truth for the file types the app accepts. Client-safe (no
 * Node imports) so both the upload UI and the server validation
 * (`content-safety.ts`) derive from the same list and never drift apart.
 */

/** Max accepted content size: 25 MB. */
export const MAX_SIZE = 25 * 1024 * 1024;

export interface SupportedType {
  /** Canonical MIME type checked against magic bytes on the server. */
  mime: string;
  /** Short label shown in the UI. */
  label: string;
  /** Primary extension. */
  ext: string;
  /** Extra extensions that map to the same MIME (e.g. jpeg → image/jpeg). */
  altExts?: string[];
}

/** Supported types grouped for display. */
export const SUPPORTED_FILE_GROUPS: { label: string; items: SupportedType[] }[] = [
  {
    label: "Immagini",
    items: [
      { mime: "image/png", label: "PNG", ext: "png" },
      { mime: "image/jpeg", label: "JPG", ext: "jpg", altExts: ["jpeg"] },
      { mime: "image/gif", label: "GIF", ext: "gif" },
      { mime: "image/webp", label: "WebP", ext: "webp" },
      { mime: "image/bmp", label: "BMP", ext: "bmp" },
    ],
  },
  {
    label: "Documenti",
    items: [
      { mime: "application/pdf", label: "PDF", ext: "pdf" },
      { mime: "text/plain", label: "TXT", ext: "txt" },
      { mime: "text/csv", label: "CSV", ext: "csv" },
    ],
  },
  {
    label: "Archivi",
    items: [{ mime: "application/zip", label: "ZIP", ext: "zip" }],
  },
];

const ALL_TYPES = SUPPORTED_FILE_GROUPS.flatMap((g) => g.items);

/** Allowlisted MIME types (used by the server's magic-byte check). */
export const SUPPORTED_MIMES = new Set(ALL_TYPES.map((t) => t.mime));

/** Allowlisted lowercase extensions (used as a client-side fallback). */
export const SUPPORTED_EXTS = new Set(
  ALL_TYPES.flatMap((t) => [t.ext, ...(t.altExts ?? [])]),
);

/** Value for an `<input type="file" accept=…>` to pre-filter the picker. */
export const ACCEPT = [
  ...SUPPORTED_MIMES,
  ...[...SUPPORTED_EXTS].map((e) => `.${e}`),
].join(",");

function extensionOf(name: string): string | null {
  const dot = name.lastIndexOf(".");
  if (dot === -1 || dot === name.length - 1) return null;
  return name.slice(dot + 1).toLowerCase();
}

/**
 * Best-effort client-side check before upload. The browser's reported MIME is
 * unreliable for text/csv, so we accept either a known MIME or a known
 * extension. The authoritative check still happens server-side on magic bytes.
 */
export function isSupportedFile(file: File): boolean {
  if (file.type && SUPPORTED_MIMES.has(file.type)) return true;
  const ext = extensionOf(file.name);
  return ext != null && SUPPORTED_EXTS.has(ext);
}

/** Human-readable size, e.g. "1.2 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[i]}`;
}
