/**
 * Session Management
 * 
 * Uses JWT tokens stored in HTTP-only cookies for session management.
 * Includes CSRF protection and rate limiting.
 */

import { cookies } from 'next/headers';
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';

// Configuration
const SESSION_COOKIE = 'ye-session';
const CSRF_COOKIE = 'ye-csrf';
const SESSION_DURATION = 60 * 60 * 24; // 24 hours in seconds

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
  iat: number;
  exp: number;
}

/**
 * Create a new session for an authenticated user
 */
export async function createSession(
  username: string,
  isAdmin: boolean,
  groups: string[]
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  
  const token = await new SignJWT({
    username,
    isAdmin,
    groups,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(now)
    .setExpirationTime(now + SESSION_DURATION)
    .sign(getJWTSecret());

  return token;
}

/**
 * Verify and decode a session token
 */
export async function verifySession(token: string): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getJWTSecret());
    return payload as SessionPayload;
  } catch {
    return null;
  }
}

/**
 * Get the current session from cookies
 */
export async function getSession(): Promise<SessionPayload | null> {
  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get(SESSION_COOKIE);
  
  if (!sessionCookie?.value) {
    return null;
  }

  return verifySession(sessionCookie.value);
}

/**
 * Set session cookies
 */
export async function setSessionCookies(token: string, csrfToken: string): Promise<void> {
  const cookieStore = await cookies();
  
  // HTTP-only session cookie
  // Note: secure should be true when using HTTPS
  const useSecure = process.env.SECURE_COOKIES === 'true';
  
  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: useSecure,
    sameSite: 'lax',
    maxAge: SESSION_DURATION,
    path: '/',
  });

  // CSRF token cookie (readable by JavaScript)
  cookieStore.set(CSRF_COOKIE, csrfToken, {
    httpOnly: false,
    secure: useSecure,
    sameSite: 'lax',
    maxAge: SESSION_DURATION,
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
 * Verify CSRF token from request
 */
export async function verifyCSRFToken(requestToken: string): Promise<boolean> {
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

/**
 * Rate limiting store (in-memory, use Redis in production)
 */
const rateLimitStore = new Map<string, { count: number; resetAt: number }>();

/**
 * Check rate limit for an IP/action combination
 */
export function checkRateLimit(
  key: string,
  maxAttempts: number,
  windowSeconds: number
): { allowed: boolean; remaining: number; resetAt: number } {
  const now = Date.now();
  const entry = rateLimitStore.get(key);

  // Clean up expired entries periodically
  if (Math.random() < 0.01) {
    for (const [k, v] of rateLimitStore) {
      if (v.resetAt < now) {
        rateLimitStore.delete(k);
      }
    }
  }

  if (!entry || entry.resetAt < now) {
    // Start new window
    const resetAt = now + windowSeconds * 1000;
    rateLimitStore.set(key, { count: 1, resetAt });
    return { allowed: true, remaining: maxAttempts - 1, resetAt };
  }

  if (entry.count >= maxAttempts) {
    return { allowed: false, remaining: 0, resetAt: entry.resetAt };
  }

  entry.count++;
  return { allowed: true, remaining: maxAttempts - entry.count, resetAt: entry.resetAt };
}

/**
 * Reset rate limit for a specific key (e.g., on successful login)
 */
export function resetRateLimit(key: string): void {
  rateLimitStore.delete(key);
}

/**
 * Reset all rate limits (admin action)
 */
export function resetAllRateLimits(): number {
  const count = rateLimitStore.size;
  rateLimitStore.clear();
  return count;
}
