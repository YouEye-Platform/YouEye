/**
 * Next.js Middleware — Authentication Guard
 *
 * Runs before every page render and API call.
 * Verifies JWT session tokens and redirects unauthenticated users to /login.
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { jwtVerify } from "jose";

/** Routes that don't require authentication */
const PUBLIC_ROUTES = [
  "/login",
  "/api/auth/sso",
  "/api/auth/callback",
  "/api/auth/logout",
  "/api/health",
  "/api/v1/branding",
  "/api/v1/header/config",
  "/api/v1/widgets",
  "/api/v1/apps/info-card",
  "/api/market-image",
  "/api/v1/onboarding",
  "/api/v1/notifications",  // Auth handled at route level (session, bridge token, app-slug)
];

/** Static resource patterns to skip */
const STATIC_PATTERNS = ["/_next/", "/favicon.ico", "/icons/", "/branding/", "/user-assets/", "/fonts/"];

function getJWTSecret(): Uint8Array | null {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) return null;
  return new TextEncoder().encode(secret);
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Skip static resources
  if (STATIC_PATTERNS.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // Allow public routes
  if (PUBLIC_ROUTES.some((r) => pathname === r || pathname.startsWith(r + "/"))) {
    return NextResponse.next();
  }

  // Allow service-to-service requests from native apps (Incus internal network).
  // Auth is validated at the route level via resolveServiceAuth().
  const serviceApp = request.headers.get("x-youeye-app");
  const serviceUser = request.headers.get("x-youeye-user");
  if (serviceApp && serviceUser && pathname.startsWith("/api/")) {
    return NextResponse.next();
  }

  // Allow CP → UI bridge token requests (server-to-server).
  // Token is validated at the route level via getBridgeToken().
  const bridgeToken = request.headers.get("x-ui-bridge-token");
  if (bridgeToken && pathname.startsWith("/api/")) {
    return NextResponse.next();
  }

  // Allow app-slug auth requests (native + marketplace apps on Incus internal network).
  // Auth validated at route level via validateAppSlugAuth() in the notifications endpoint.
  const appSlug = request.headers.get("x-app-slug");
  if (appSlug && pathname.startsWith("/api/")) {
    return NextResponse.next();
  }

  // Check session cookie
  const sessionCookie = request.cookies.get("ye-ui-session");

  if (!sessionCookie?.value) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.redirect(new URL("/login", request.url));
  }

  // Verify JWT
  const secret = getJWTSecret();
  if (!secret) {
    // Can't verify — let through, page will handle
    return NextResponse.next();
  }

  try {
    await jwtVerify(sessionCookie.value, secret);
    return NextResponse.next();
  } catch {
    // Invalid or expired token — redirect to login
    const response = pathname.startsWith("/api/")
      ? NextResponse.json({ error: "Session expired" }, { status: 401 })
      : NextResponse.redirect(new URL("/login", request.url));

    response.cookies.delete("ye-ui-session");
    response.cookies.delete("ye-ui-csrf");
    return response;
  }
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|icons).*)",
  ],
};
