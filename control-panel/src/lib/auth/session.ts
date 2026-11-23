/**
 * Session Management
 * 
 * Uses JWT tokens stored in HTTP-only cookies for session management.
 * Includes CSRF protection and rate limiting.
 */

import { cookies, headers } from 'next/headers';
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { randomBytes } from 'crypto';
import { getUserByUsername, isIdentitySessionActiveForUser, isUserTokenInvalidated } from '@/lib/identity/store';
import { identitySessionFromCookie, SESSION_COOKIE as ID_SESSION_COOKIE } from '@/lib/identity/tokens';
import { hasAppServiceAuthHeaders } from '../../../../shared/app-service-credential';
import { secureCookieFor } from './mode';
import { isValidCLIToken } from './cli-token';

// Configuration
const SESSION_COOKIE = 'ye-session';
const CSRF_COOKIE = 'ye-csrf';
const SESSION_DURATION = 60 * 60 * 24; // Local/PAM recovery session: 24 hours
const SSO_SESSION_DURATION = 60 * 60 * 24 * 30;
const SETUP_SESSION_DURATION = 60 * 60 * 2; // 2 hours in seconds

/**
 * Get JWT secret - enforces JWT_SECRET environment variable is set
 * Uses lazy initialization to allow Next.js build to succeed
 */
let jwtSecretCached: Uint8Array | null = null;

function getJWTSecret(): Uint8Array {
  if (jwtSecretCached) {
    return jwtSecretCached;
  }

  const secret = process.env.JWT_SECRET;
  
  if (!secret) {
    throw new Error(
      'JWT_SECRET environment variable is required. ' +
      'Generate one with: openssl rand -base64 64'
    );
  }
  
  if (secret.length < 32) {
    throw new Error(
      'JWT_SECRET must be at least 32 characters. ' +
      'Generate a secure secret with: openssl rand -base64 64'
    );
  }
  
  jwtSecretCached = new TextEncoder().encode(secret);
  return jwtSecretCached;
}

export interface SessionPayload extends JWTPayload {
  username: string;
  isAdmin: boolean;
  groups: string[];
  authMethod?: 'pam' | 'sso' | 'cli' | 'setup';
  identityId?: string;
  identitySessionId?: string;
  setupOwnerId?: string;
  setupSessionId?: string;
  iat: number;
  exp: number;
}

/**
 * Create a new session for an authenticated user
 */
export async function createSession(
  username: string,
  isAdmin: boolean,
  groups: string[],
  authMethod: 'pam' | 'sso' = 'pam',
  identity?: { userId: string; sessionId: string | null },
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  
  const token = await new SignJWT({
    username,
    isAdmin,
    groups,
    authMethod,
    ...(identity ? { identityId: identity.userId, identitySessionId: identity.sessionId } : {}),
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(now)
    .setExpirationTime(now + (authMethod === 'sso' ? SSO_SESSION_DURATION : SESSION_DURATION))
    .sign(getJWTSecret());

  return token;
}

/** Create a constrained session used only by the claimed appliance owner during setup. */
export async function createSetupSession(input: {
  ownerId: string;
  username: string;
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    username: input.username,
    isAdmin: true,
    groups: ['youeye-users', 'admin'],
    authMethod: 'setup',
    setupOwnerId: input.ownerId,
    setupSessionId: randomBytes(24).toString('hex'),
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(now)
    .setExpirationTime(now + SETUP_SESSION_DURATION)
    .sign(getJWTSecret());
}

/**
 * Verify and decode a session token
 */
export async function verifySession(token: string): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getJWTSecret());
    const session = payload as SessionPayload;
    if (session.authMethod === 'setup') return session;
    if (session.identitySessionId && session.identityId) {
      return await isIdentitySessionActiveForUser(session.identitySessionId, session.identityId) ? session : null;
    }
    if (session.iat) {
      const user = await getUserByUsername(session.username);
      if (user && await isUserTokenInvalidated(user.id, session.iat)) return null;
    }
    return session;
  } catch {
    return null;
  }
}

/**
 * Get the current session from cookies, or from CLI token header.
 * CLI token grants admin-level access without a browser session.
 */
export async function getSession(): Promise<SessionPayload | null> {
  // Check CLI token first
  const headerStore = await headers();
  if (hasAppServiceAuthHeaders(headerStore)) return null;
  const cliToken = headerStore.get('x-cli-token');
  if (cliToken && isValidCLIToken(cliToken)) {
    // Return a synthetic admin session for CLI access
    const now = Math.floor(Date.now() / 1000);
    return {
      username: 'cli',
      isAdmin: true,
      groups: ['sudo', 'cli'],
      authMethod: 'cli',
      iat: now,
      exp: now + 3600,
    };
  }

  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get(SESSION_COOKIE);

  if (!sessionCookie?.value) {
    return null;
  }

  const session = await verifySession(sessionCookie.value);
  if (!session || session.authMethod !== 'sso') return session;
  const idCookie = cookieStore.get(ID_SESSION_COOKIE)?.value;
  if (!idCookie) return null;
  const identity = await identitySessionFromCookie(idCookie);
  if (!identity) return null;
  if (session.identityId && session.identityId !== identity.sub) return null;
  if (session.identitySessionId && session.identitySessionId !== identity.sid) return null;
  return session;
}

/**
 * Set session cookies. `Secure` follows `secureCookieFor`: always on named hosts, by scheme on a local setup host.
 */
export async function setSessionCookies(
  token: string,
  csrfToken: string,
  options: { request?: Request; maxAge?: number } = {}
): Promise<void> {
  const cookieStore = await cookies();
  const secure = secureCookieFor(options.request);
  const sameSite = secure ? 'none' : 'lax';
  const sessionAge = options.maxAge ?? SSO_SESSION_DURATION;
  
  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite,
    maxAge: sessionAge,
    path: '/',
  });

  // CSRF token cookie (readable by JavaScript)
  cookieStore.set(CSRF_COOKIE, csrfToken, {
    httpOnly: false,
    secure,
    sameSite,
    maxAge: sessionAge,
    path: '/',
  });
}

/**
 * Clear session cookies (logout)
 */
export async function clearSessionCookies(): Promise<void> {
  const cookieStore = await cookies();
  
  cookieStore.delete(SESSION_COOKIE);
  cookieStore.delete(CSRF_COOKIE);
}

/**
 * Generate a CSRF token
 */
export function generateCSRFToken(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Verify CSRF token from request.
 * CLI token requests bypass CSRF (the token itself is the auth credential).
 */
export async function verifyCSRFToken(requestToken: string): Promise<boolean> {
  // CLI token requests bypass CSRF — the CLI token IS the credential
  const headerStore = await headers();
  const cliToken = headerStore.get('x-cli-token');
  if (cliToken && isValidCLIToken(cliToken)) {
    return true;
  }

  const cookieStore = await cookies();
  const csrfCookie = cookieStore.get(CSRF_COOKIE);

  if (!csrfCookie?.value || !requestToken) {
    return false;
  }

  // Constant-time comparison to prevent timing attacks
  if (csrfCookie.value.length !== requestToken.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < csrfCookie.value.length; i++) {
    result |= csrfCookie.value.charCodeAt(i) ^ requestToken.charCodeAt(i);
  }

  return result === 0;
}

// Rate limiting lives in `rate-limit.ts` (no Next or database imports); re-exported for existing callers.
export { checkRateLimit, resetRateLimit, resetAllRateLimits } from './rate-limit';
