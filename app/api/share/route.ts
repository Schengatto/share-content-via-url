import { NextRequest, NextResponse } from "next/server";
import { appDb, appBlobs, ensureStarted, shareUrl } from "@/lib/app";
import { assertValidShareOptions, createE2eShare, createShare, type CreateE2eInput } from "@/lib/store";
import { E2E_FORMAT, fromBase64Url } from "@/lib/e2e-crypto";
import { DEFAULT_TTL_SECONDS, DEFAULT_VIEWS } from "@/lib/share-options";
import { validateContent, MAX_SIZE } from "@/lib/content-safety";
import { shareCreationLimiter } from "@/lib/rate-limit";
import { clientIp } from "@/lib/client-ip";

// Reject oversized uploads from the Content-Length header BEFORE buffering the
// whole body into memory (the precise byte check still runs in validateContent).
// 1MB of slack covers multipart/form-data framing overhead.
const MAX_UPLOAD = MAX_SIZE + 1024 * 1024;

const OUT_OF_DATE_PAGE_ERROR = "This page is out of date. Reload it and try again.";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function numberField(value: FormDataEntryValue | null, fallback: number): number {
  if (typeof value !== "string" || value.trim() === "") return fallback;
  return Number(value);
}

function optionalPasswordField(value: FormDataEntryValue | null): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function errorResponse(e: unknown): NextResponse {
  const err = e as { status?: number; message?: string };
  if (typeof err.status === "number") {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  return NextResponse.json({ error: "Internal error" }, { status: 500 });
}

async function createEncryptedTextShare(req: NextRequest, form: FormData): Promise<NextResponse> {
  const ciphertext = form.get("ciphertext");
  const iv = form.get("iv");
  const salt = form.get("salt");
  const linkProofHash = form.get("linkProofHash");
  const authHash = form.get("authHash");
  if (
    form.get("encryption") !== E2E_FORMAT ||
    !(ciphertext instanceof File) ||
    typeof iv !== "string" ||
    typeof salt !== "string" ||
    typeof linkProofHash !== "string"
  ) {
    return NextResponse.json({ error: OUT_OF_DATE_PAGE_ERROR }, { status: 400 });
  }

  let input: CreateE2eInput;
  try {
    input = {
      ciphertext: Buffer.from(await ciphertext.arrayBuffer()),
      iv: Buffer.from(fromBase64Url(iv)),
      salt: Buffer.from(fromBase64Url(salt)),
      kdfIterations: numberField(form.get("kdfIterations"), NaN),
      linkProofHash,
      authHash: typeof authHash === "string" ? authHash : null,
      maxAccesses: numberField(form.get("maxAccesses"), DEFAULT_VIEWS),
      ttlSeconds: numberField(form.get("ttlSeconds"), DEFAULT_TTL_SECONDS),
    };
  } catch {
    return NextResponse.json({ error: "Invalid encrypted payload" }, { status: 400 });
  }

  try {
    const { linkId, revokeToken } = createE2eShare(appDb(), appBlobs(), input);
    return NextResponse.json({ id: linkId, url: shareUrl(req.nextUrl.origin, linkId), revokeToken });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  ensureStarted();

  if (!shareCreationLimiter.allow(clientIp(req.headers))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const contentLength = Number(req.headers.get("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_UPLOAD) {
    return NextResponse.json(
      { error: "Content exceeds 25MB limit" },
      { status: 413 },
    );
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Invalid form data" }, { status: 400 });
  }

  const kind = form.get("kind");
  let buffer: Buffer;
  let mime: string;
  let filename: string | undefined;

  if (kind === "text") {
    return createEncryptedTextShare(req, form);
  } else if (kind === "file") {
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) {
      return NextResponse.json({ error: "A file is required" }, { status: 400 });
    }
    buffer = Buffer.from(await file.arrayBuffer());
    mime = file.type || "application/octet-stream";
    filename = file.name;
  } else {
    return NextResponse.json({ error: "Invalid kind" }, { status: 400 });
  }

  const options = {
    maxAccesses: numberField(form.get("maxAccesses"), DEFAULT_VIEWS),
    ttlSeconds: numberField(form.get("ttlSeconds"), DEFAULT_TTL_SECONDS),
    password: optionalPasswordField(form.get("password")),
  };

  try {
    assertValidShareOptions(options);
    await validateContent({ kind, buffer, declaredMime: mime, filename });
    const { token, revokeToken } = await createShare(appDb(), appBlobs(), {
      kind,
      content: buffer,
      mime,
      filename,
      ...options,
    });
    return NextResponse.json({ url: shareUrl(req.nextUrl.origin, token), revokeToken });
  } catch (e) {
    return errorResponse(e);
  }
}
