import { NextResponse, type NextRequest } from "next/server";
import { buildContentSecurityPolicy, generateNonce } from "@/lib/content-security-policy";

export function proxy(request: NextRequest): NextResponse {
  const nonce = generateNonce();
  const contentSecurityPolicy = buildContentSecurityPolicy(
    nonce,
    process.env.NODE_ENV === "development",
  );

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("Content-Security-Policy", contentSecurityPolicy);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", contentSecurityPolicy);
  return response;
}

export const config = {
  matcher: [
    {
      source: "/((?!api/|api$|_next/static|_next/image|favicon\\.ico).*)",
      missing: [{ type: "header", key: "next-router-prefetch" }],
    },
  ],
};
