import { fileTypeFromBuffer } from "file-type";
import { scanWithClamd } from "./clamav";
import { MAX_SIZE, SUPPORTED_MIMES } from "./file-support";

// Re-exported so existing importers keep getting the limit from here.
export { MAX_SIZE };

/** MIME types accepted for `file` shares (allowlist, shared with the UI). */
const ALLOWED_MIME = SUPPORTED_MIMES;

/** Declared types that `file-type` legitimately cannot sniff (no magic bytes). */
const TEXTLIKE_MIME = new Set(["text/plain", "text/csv"]);

/** The generic browser fallback type; treated as "unknown, trust the sniffer". */
const GENERIC_MIME = "application/octet-stream";

/**
 * Browsers report inconsistent MIME types for the same content (e.g. Windows
 * Chrome/Edge label a .zip `application/x-zip-compressed`). Map those aliases to
 * the canonical type `file-type` sniffs, so legit uploads aren't rejected as a
 * mismatch. The sniffed type stays authoritative for the allowlist check.
 */
const MIME_ALIASES: Record<string, string> = {
  "application/x-zip-compressed": "application/zip",
  "application/x-zip": "application/zip",
  "application/x-compressed": "application/zip",
  "image/jpg": "image/jpeg",
  "image/pjpeg": "image/jpeg",
  "image/x-png": "image/png",
  "image/x-ms-bmp": "image/bmp",
};

function canonicalMime(mime: string): string {
  return MIME_ALIASES[mime] ?? mime;
}

/** Extensions that must never be shared, regardless of declared type. */
const BLOCKED_EXT = new Set([
  "exe", "bat", "cmd", "com", "msi", "msp", "mst", "scr", "ps1", "ps2",
  "psc1", "vbs", "vbe", "vb", "wsf", "wsh", "wsc", "ws", "sh", "bash",
  "js", "mjs", "cjs", "jar", "php", "py", "rb", "pl", "html", "htm",
  "xhtml", "xht", "svg", "svgz", "dll", "hta", "jse", "lnk", "scf",
  "inf", "reg", "cpl", "chm", "hlp", "gadget",
]);

export type ScanResult = { infected: boolean; signature?: string };
export type Scanner = (buffer: Buffer) => Promise<ScanResult>;

export class ContentSafetyError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
  ) {
    super(message);
    this.name = "ContentSafetyError";
  }
}

export interface ValidateInput {
  kind: "text" | "file";
  buffer: Buffer;
  declaredMime: string;
  filename?: string;
}

/** Every dotted segment of the filename, lowercased (e.g. "a.php.txt" → [php, txt]). */
function extensionsOf(filename?: string): string[] {
  if (!filename) return [];
  return filename.toLowerCase().split(".").slice(1).filter(Boolean);
}

/**
 * Default scanner: only reaches out to clamd when CLAMAV_ENABLED=true,
 * otherwise reports clean (static validation only). Injectable for tests.
 */
const defaultScanner: Scanner = async (buffer) => {
  if (process.env.CLAMAV_ENABLED === "true") {
    return scanWithClamd(buffer);
  }
  return { infected: false };
};

/**
 * Validate content on the plaintext, BEFORE encryption (the server cannot read
 * it afterwards). Throws ContentSafetyError; resolves to void when safe.
 */
export async function validateContent(
  input: ValidateInput,
  scan: Scanner = defaultScanner,
): Promise<void> {
  const { kind, buffer, declaredMime, filename } = input;

  // 1. Size limit (both kinds).
  if (buffer.length > MAX_SIZE) {
    throw new ContentSafetyError("Content exceeds 25MB limit", 413, "TOO_LARGE");
  }

  if (kind === "file") {
    // 2. Blocked extensions (check every dotted segment, not just the last).
    const blocked = extensionsOf(filename).find((e) => BLOCKED_EXT.has(e));
    if (blocked) {
      throw new ContentSafetyError(
        `Blocked file extension: .${blocked}`,
        415,
        "BLOCKED_EXTENSION",
      );
    }

    // 3. Magic-byte sniffing must corroborate the declared type. A generic
    //    "application/octet-stream" (common when the browser can't guess) is
    //    treated as "unknown" and trusts the sniffed type rather than failing.
    const detected = await fileTypeFromBuffer(buffer);
    if (detected) {
      if (!ALLOWED_MIME.has(detected.mime)) {
        throw new ContentSafetyError(
          `Type not allowed: ${detected.mime}`,
          415,
          "TYPE_NOT_ALLOWED",
        );
      }
      const declared = canonicalMime(declaredMime);
      if (declared !== GENERIC_MIME && declared !== detected.mime) {
        throw new ContentSafetyError(
          `Declared type ${declaredMime} does not match content ${detected.mime}`,
          415,
          "TYPE_MISMATCH",
        );
      }
    } else {
      // Undetectable: accept only the text-like allowlisted types.
      if (!TEXTLIKE_MIME.has(declaredMime)) {
        throw new ContentSafetyError(
          `Unverifiable content type: ${declaredMime}`,
          415,
          "TYPE_UNVERIFIABLE",
        );
      }
    }
  }
  // For text shares only the size limit applies; rendering is always escaped.

  // 4. Optional ClamAV scan.
  const result = await scan(buffer);
  if (result.infected) {
    throw new ContentSafetyError(
      `Malicious content detected${result.signature ? `: ${result.signature}` : ""}`,
      422,
      "INFECTED",
    );
  }
}
