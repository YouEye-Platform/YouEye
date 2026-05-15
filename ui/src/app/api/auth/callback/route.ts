/**
 * OAuth2 Callback Route
 *
 * GET /api/auth/callback?code=...&state=...
 * Exchanges the authorization code for tokens, fetches user info,
 * upserts the user in the database, and creates a JWT session.
 *
 * CRITICAL: All cookies must be set directly on the NextResponse object.
 * Using cookies() from next/headers writes to an implicit response context
 * that does NOT merge into NextResponse.redirect() — causing cookies to be
 * silently dropped. This was the root cause of the "Invalid state" error.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  exchangeCodeForToken,
  fetchUserInfo,
  isSSOConfigured,
  createSession,
  generateCSRFToken,
} from "@/lib/auth";
import { upsertUser } from "@/lib/db/queries/users";

const ADMIN_GROUP = "authentik Admins";
const SESSION_DURATION = 60 * 60 * 24 * 7; // 7 days

export async function GET(request: NextRequest) {
  if (!isSSOConfigured()) {
    return NextResponse.json({ error: "SSO not configured" }, { status: 503 });
  }

  // Determine external base URL for redirects
  const externalUrl = process.env.UI_EXTERNAL_URL;
  let baseUrl: string;
  if (externalUrl) {
    baseUrl = externalUrl;
  } else {
    const host = request.headers.get("host") || "";
    const proto = request.headers.get("x-forwarded-proto") || "http";
    baseUrl = `${proto}://${host}`;
  }

  // Respect SECURE_COOKIES env var (consistent with sso/route.ts)
  const useSecure = process.env.SECURE_COOKIES !== "false";

  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  const errorParam = request.nextUrl.searchParams.get("error");

  // Handle Authentik errors
  if (errorParam) {
    const desc =
      request.nextUrl.searchParams.get("error_description") || errorParam;
    console.error(`OAuth2 error: ${desc}`);
    const response = NextResponse.redirect(
      new URL(`/login?error=${encodeURIComponent(desc)}`, baseUrl)
    );
    response.cookies.delete("oauth-state");
    return response;
  }

  if (!code || !state) {
    const response = NextResponse.redirect(
      new URL("/login?error=Missing+code+or+state", baseUrl)
    );
    response.cookies.delete("oauth-state");
    return response;
  }

  // Read state from the actual HTTP Cookie header (request.cookies),
  // NOT from cookies() which uses the implicit response context.
  const savedState = request.cookies.get("oauth-state")?.value;

  if (!savedState || savedState !== state) {
    // Diagnostic logging for debugging
    const allCookieNames = request.cookies.getAll().map((c) => c.name).join(",");
    console.error(
      "OAuth2 state mismatch — " +
        `savedState=${savedState ? `present(${savedState.substring(0, 8)}...)` : "MISSING"}, ` +
        `urlState=${state.substring(0, 8)}..., ` +
        `cookies=[${allCookieNames}], ` +
        `host=${request.headers.get("host")}, ` +
        `referer=${request.headers.get("referer") || "none"}, ` +
        `secure_cookies=${process.env.SECURE_COOKIES || "unset"}`
    );
    const response = NextResponse.redirect(
      new URL("/login?error=Invalid+state", baseUrl)
    );
    response.cookies.delete("oauth-state");
    return response;
  }

  try {
    const redirectUri = `${baseUrl}/api/auth/callback`;

    // Exchange code for access token
    const tokenData = await exchangeCodeForToken(code, redirectUri);

    // Fetch user profile from Authentik
    const userInfo = await fetchUserInfo(tokenData.access_token);

    const username = userInfo.preferred_username || userInfo.sub;
    const groups = userInfo.groups || [];
    const isAdmin = groups.includes(ADMIN_GROUP);

    // Upsert user in database (sync name fields from Authentik)
    const firstName = userInfo.given_name || null;
    const lastName = userInfo.family_name || null;
    const user = await upsertUser({
      authentikId: userInfo.sub,
      username,
      name: userInfo.name || username,
      email: userInfo.email || "",
      isAdmin,
      firstName,
      lastName,
    });

    // Create JWT session
    const sessionToken = await createSession({
      userId: user.id,
      authentikId: userInfo.sub,
      username,
      name: userInfo.name || username,
      email: userInfo.email || "",
      isAdmin: user.isAdmin ?? isAdmin,
      groups,
    });

    const csrfToken = generateCSRFToken();

    console.log(`SSO login: "${username}" (admin: ${user.isAdmin})`);

    // Set ALL cookies directly on the redirect response.
    // Do NOT use setSessionCookies() — it writes to the implicit response
    // context via cookies() which won't merge into NextResponse.redirect().
    const response = NextResponse.redirect(new URL("/", baseUrl));

    response.cookies.set("ye-ui-session", sessionToken, {
      httpOnly: true,
      secure: useSecure,
      sameSite: "lax",
      maxAge: SESSION_DURATION,
      path: "/",
    });

    response.cookies.set("ye-ui-csrf", csrfToken, {
      httpOnly: false,
      secure: useSecure,
      sameSite: "lax",
      maxAge: SESSION_DURATION,
      path: "/",
    });

    // Clean up the oauth-state cookie
    response.cookies.delete("oauth-state");

    return response;
  } catch (error) {
    console.error("OAuth2 callback error:", error);
    const msg =
      error instanceof Error ? error.message : "Authentication failed";
    const response = NextResponse.redirect(
      new URL(`/login?error=${encodeURIComponent(msg)}`, baseUrl)
    );
    response.cookies.delete("oauth-state");
    return response;
  }
}
