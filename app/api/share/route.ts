import { NextRequest, NextResponse } from "next/server";
import { appDb, appBlobs, ensureStarted, shareUrl } from "@/lib/app";
import { assertValidShareOptions, createShare } from "@/lib/store";
import { DEFAULT_TTL_SECONDS, DEFAULT_VIEWS } from "@/lib/share-options";
import { validateContent, MAX_SIZE } from "@/lib/content-safety";
import { shareCreationLimiter } from "@/lib/rate-limit";

// Reject oversized uploads from the Content-Length header BEFORE buffering the
// whole body into memory (the precise byte check still runs in validateContent).
// 1MB of slack covers multipart/form-data framing overhead.
const MAX_UPLOAD = MAX_SIZE + 1024 * 1024;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function numberField(value: FormDataEntryValue | null, fallback: number): number {
  if (typeof value !== "string" || value.trim() === "") return fallback;
  return Number(value);
}

function optionalPasswordField(value: FormDataEntryValue | null): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

export async function POST(req: NextRequest) {
  ensureStarted();

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (!shareCreationLimiter.allow(ip)) {
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
    const text = form.get("text");
    if (typeof text !== "string" || text.length === 0) {
      return NextResponse.json({ error: "Text is required" }, { status: 400 });
    }
    buffer = Buffer.from(text, "utf8");
    mime = "text/plain";
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
    const { token } = await createShare(appDb(), appBlobs(), {
      kind,
      content: buffer,
      mime,
      filename,
      ...options,
    });
    return NextResponse.json({ url: shareUrl(req.nextUrl.origin, token) });
  } catch (e) {
    const err = e as { status?: number; message?: string };
    if (typeof err.status === "number") {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
