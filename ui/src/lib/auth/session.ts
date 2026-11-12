/**
 * JWT Session Management
 *
 * Uses signed JWT tokens stored in HTTP-only cookies.
 * No database sessions — stateless authentication.
 *
 * Cookie: ye-ui-session (HTTP-only, Secure, SameSite=Lax)
 * Cookie: ye-ui-csrf (readable by JS for CSRF protection)
 */

import { cookies, headers } from "next/headers";
import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import { hasMachineAuthHeaders } from "./service-request";

const SESSION_COOKIE = "ye-ui-session";
const CSRF_COOKIE = "ye-ui-csrf";
const SESSION_DURATION = 60 * 60 * 24 * 30; // ID session sets the earlier 7-day idle limit

/** Lazy-initialized JWT secret from environment */
let jwtSecretCached: Uint8Array | null = null;

function getJWTSecret(): Uint8Array {
  if (jwtSecretCached) return jwtSecretCached;

  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET environment variable is required.");
  }
  if (secret.length < 32) {
    throw new Error("JWT_SECRET must be at least 32 characters.");
  }

  jwtSecretCached = new TextEncoder().encode(secret);
  return jwtSecretCached;
}

/** Session payload stored in the JWT */
export interface SessionPayload extends JWTPayload {
  /** Internal database user ID (UUID) */
  userId: string;
  /** identity provider user ID (sub claim) — used for app-level user identity */
  identityId: string;
  identitySessionId: string;
  /** Set only by exact installed browser-origin resolution, never cookie claims. */
  actingAppId?: string;
  /** Display username */
  username: string;
  /** Display name */
  name: string;
  /** Email address */
  email: string;
  /** Whether the user belongs to an admin identity group */
  isAdmin: boolean;
  /** identity provider group memberships */
  groups: string[];
}

/** Create a signed JWT session token */
export async function createSession(payload: {
  userId: string;
  identityId: string;
  identitySessionId: string;
  username: string;
  name: string;
  email: string;
  isAdmin: boolean;
  groups: string[];
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);

  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(now)
    .setExpirationTime(now + SESSION_DURATION)
    .sign(getJWTSecret());
}

/** Verify and decode a JWT session token */
export async function verifySession(
  token: string
): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getJWTSecret());
    return payload as SessionPayload;
  } catch {
    return null;
  }
}

/** Get the current session from cookies */
export async function getSession(options: { allowAppOrigin?: boolean } = {}): Promise<SessionPayload | null> {
  const requestHeaders = await headers();
  if (hasMachineAuthHeaders(requestHeaders)) return null;
  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get(SESSION_COOKIE);
  if (!sessionCookie?.value) return null;
  const session = await verifySession(sessionCookie.value);
  if (!session) return null;
  const identityUrl = process.env.IDENTITY_INTERNAL_URL || process.env.IDENTITY_URL;
  if (identityUrl) {
    if (!session.identityId || !session.identitySessionId) return null;
    try {
      // Provider session validation, preserving the existing auth boundary;
      // app admission is always evaluated locally from CP's push.
      const check = await fetch(`${identityUrl}/identity/session/check`, {
        headers: { cookie: requestHeaders.get('cookie') || '',
          'x-youeye-expected-sub': session.identityId, 'x-youeye-expected-sid': session.identitySessionId },
        cache: 'no-store', signal: AbortSignal.timeout(5_000),
      });
      if (check.status !== 204) return null;
    } catch { return null; }
  }
  const origin = requestHeaders.get('origin');
  const configured = process.env.UI_EXTERNAL_URL || process.env.BASE_URL || process.env.NEXTAUTH_URL;
  if (!origin) return session;
  if (!configured) return null;
  let base: URL, caller: URL;
  try { base = new URL(configured); caller = new URL(origin); } catch { return null; }
  if (caller.origin === base.origin) return session;
  // Browser/admin APIs are platform-origin only unless a handler explicitly
  // opts into app-origin service behavior and checks its runtime permission.
  if (!options.allowAppOrigin) return null;
  if (caller.protocol !== 'https:' || caller.port || caller.username || caller.password) return null;
  const { db, ensureSchema } = await import('@/db');
  const { apps } = await import('@/db/schema');
  const { evaluateLocalAdmission } = await import('@/lib/admission/store');
  await ensureSchema();
  const registered = await db.select({ id: apps.id, subdomain: apps.subdomain }).from(apps);
  const candidates = registered.filter(app => app.subdomain && `${app.subdomain}.${base.hostname}` === caller.hostname);
  if (candidates.length !== 1 || !evaluateLocalAdmission(candidates[0].id, session.identityId).allowed) return null;
  // An app's browser origin does not inherit browser-admin authority.
  return { ...session, isAdmin: false, actingAppId: candidates[0].id };
}

/** Set session cookies after successful authentication */
export async function setSessionCookies(
  token: string,
  csrfToken: string
): Promise<void> {
  const cookieStore = await cookies();
  const useSecure = process.env.SECURE_COOKIES !== "false";

  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: useSecure,
    sameSite: "lax",
    maxAge: SESSION_DURATION,
    path: "/",
  });

  cookieStore.set(CSRF_COOKIE, csrfToken, {
    httpOnly: false,
    secure: useSecure,
    sameSite: "lax",
    maxAge: SESSION_DURATION,
    path: "/",
  });
}

/** Clear session cookies (logout) */
export async function clearSessionCookies(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE);
  cookieStore.delete(CSRF_COOKIE);
}

/** Generate a random CSRF token */
export function generateCSRFToken(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, (b) => b.toString(16).padStart(2, "0")).join("");
}
