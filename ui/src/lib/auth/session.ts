/**
 * JWT Session Management
 *
 * Uses signed JWT tokens stored in HTTP-only cookies.
 * No database sessions — stateless authentication.
 *
 * Cookie: ye-ui-session (HTTP-only, Secure, SameSite=Lax)
 * Cookie: ye-ui-csrf (readable by JS for CSRF protection)
 */

import { cookies } from "next/headers";
import { SignJWT, jwtVerify, type JWTPayload } from "jose";

const SESSION_COOKIE = "ye-ui-session";
const CSRF_COOKIE = "ye-ui-csrf";
const SESSION_DURATION = 60 * 60 * 24 * 7; // 7 days

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
  /** Authentik user ID (sub claim) — used for app-level user identity */
  authentikId: string;
  /** Display username */
  username: string;
  /** Display name */
  name: string;
  /** Email address */
  email: string;
  /** Whether user is an admin (in 'authentik Admins' group) */
  isAdmin: boolean;
  /** Authentik group memberships */
  groups: string[];
}

/** Create a signed JWT session token */
export async function createSession(payload: {
  userId: string;
  authentikId: string;
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
export async function getSession(): Promise<SessionPayload | null> {
  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get(SESSION_COOKIE);
  if (!sessionCookie?.value) return null;
  return verifySession(sessionCookie.value);
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
