/**
 * SSO Initiation Route
 *
 * GET /api/auth/sso
 * Redirects the user to Authentik's OAuth2 authorize endpoint.
 * Stores a random state parameter in a cookie for CSRF protection.
 *
 * IMPORTANT: The oauth-state cookie MUST be set directly on the
 * NextResponse.redirect() object — NOT via cookies() from next/headers.
 * Using cookies().set() writes to the implicit response context, which
 * may not be merged into NewResponse.redirect() in all Next.js versions,
 * causing the "Invalid state" error on callback.
 */

import { NextRequest, NextResponse } from "next/server";
import { buildAuthorizeUrl, generateOAuthState, isSSOConfigured } from "@/lib/auth";

export async function GET(request: NextRequest) {
  if (!isSSOConfigured()) {
    return NextResponse.json({ error: "SSO not configured" }, { status: 503 });
  }

  // Build redirect URI using UI_EXTERNAL_URL or request headers
  const externalUrl = process.env.UI_EXTERNAL_URL;
  let redirectUri: string;

  if (externalUrl) {
    redirectUri = `${externalUrl}/api/auth/callback`;
  } else {
    const host = request.headers.get("host") || "";
    const proto = request.headers.get("x-forwarded-proto") || "http";
    redirectUri = `${proto}://${host}/api/auth/callback`;
  }

  // Generate CSRF state
  const state = generateOAuthState();

  // Respect SECURE_COOKIES env var (set to "false" for self-signed cert environments)
  const useSecure =
    process.env.SECURE_COOKIES !== "false" &&
    redirectUri.startsWith("https://");

  // Build redirect to Authentik authorize URL
  const authorizeUrl = buildAuthorizeUrl(redirectUri, state);
  const response = NextResponse.redirect(authorizeUrl);

  // Set oauth-state cookie directly on the redirect response.
  // This guarantees the Set-Cookie header is included in the 302 response.
  response.cookies.set("oauth-state", state, {
    httpOnly: true,
    secure: useSecure,
    sameSite: "lax",
    maxAge: 300, // 5 minutes
    path: "/",
  });

  return response;
}
