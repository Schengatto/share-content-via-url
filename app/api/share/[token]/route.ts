import { NextRequest, NextResponse } from "next/server";
import { appDb, appBlobs, ensureStarted } from "@/lib/app";
import { revokeShare } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  ensureStarted();
  const { token } = await params;
  const revokeToken = req.headers.get("x-revoke-token") ?? undefined;
  const removed = revokeShare(appDb(), appBlobs(), token, revokeToken);
  if (!removed) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ revoked: true });
}
