/**
 * YouEye ID sign-in limits (YE-134).
 *
 * - Per username, from any address: 10 failed sign-ins in 15 minutes lock that username until the window ends. This
 *   is what stops guessing one account's password from many addresses; it cannot be got around by changing address.
 * - Per client address: 30 failed sign-ins in 15 minutes, across usernames, stop that address (password spraying).
 *   Loopback and an unknown address are not client addresses: until Caddy's proxy devices send the real client
 *   (`lib/caddy/client-address.ts`), every client arrives as 127.0.0.1, and a limit on it would let anyone lock
 *   everyone out.
 *
 * Only failures count: a success clears the username's count and gives back the address's attempt, and a refused
 * attempt counts against nothing. Unknown usernames are limited exactly like real ones, and the refusal says the
 * same for both, so neither the limit nor its message tells whether a user exists.
 */

import { checkRateLimit, isRateLimited, refundRateLimit, resetRateLimit } from '@/lib/auth/rate-limit';

export const SIGN_IN_WINDOW_SECONDS = 15 * 60;
export const SIGN_IN_USERNAME_ATTEMPTS = 10;
export const SIGN_IN_ADDRESS_ATTEMPTS = 30;

export interface SignInAttempt {
  allowed: boolean;
  /** When the limit that refused the attempt ends (ms since the epoch); 0 when allowed. */
  retryAt: number;
  usernameKey: string;
  addressKey: string | null;
}

/** The client's address as Caddy sent it (`X-Forwarded-For`, first entry), or null for loopback and unknown. */
export function signInClientAddress(headers: Headers): string | null {
  const raw = headers.get('x-forwarded-for')?.split(',')[0]?.trim() || headers.get('x-real-ip')?.trim() || '';
  const address = raw.toLowerCase().replace(/^::ffff:/, '');
  if (!address || address === 'unknown' || address === '::1' || /^127\./.test(address)) return null;
  return address.slice(0, 64);
}

function usernameKey(username: string): string {
  return `id-login-user:${username.trim().toLowerCase().slice(0, 256)}`;
}

/** Check both limits and, when the attempt may go ahead, count it against both. */
export function beginSignInAttempt(username: string, address: string | null): SignInAttempt {
  const userKey = usernameKey(username);
  const addressKey = address ? `id-login-address:${address}` : null;
  const refusals = [
    isRateLimited(userKey, SIGN_IN_USERNAME_ATTEMPTS),
    ...(addressKey ? [isRateLimited(addressKey, SIGN_IN_ADDRESS_ATTEMPTS)] : []),
  ].filter((state) => state.limited);
  if (refusals.length > 0) {
    return { allowed: false, retryAt: Math.max(...refusals.map((state) => state.resetAt)), usernameKey: userKey, addressKey };
  }
  checkRateLimit(userKey, SIGN_IN_USERNAME_ATTEMPTS, SIGN_IN_WINDOW_SECONDS);
  if (addressKey) checkRateLimit(addressKey, SIGN_IN_ADDRESS_ATTEMPTS, SIGN_IN_WINDOW_SECONDS);
  return { allowed: true, retryAt: 0, usernameKey: userKey, addressKey };
}

/** After a successful sign-in: the username starts over, and the address gets its attempt back. */
export function signInSucceeded(attempt: SignInAttempt): void {
  resetRateLimit(attempt.usernameKey);
  if (attempt.addressKey) refundRateLimit(attempt.addressKey);
}
