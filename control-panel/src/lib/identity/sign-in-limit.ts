/**
 * Sign-in limits (YE-134; YE-136 made them per scope and keyed them on the real client).
 *
 * Each scope has its own counts: YouEye ID's sign-in (`id-login`), the Control Panel's PAM login (`cp-login`) and
 * the appliance claim (`appliance-claim`).
 *
 * - Per username, from any address: 10 failed sign-ins in 15 minutes lock that username until the window ends. This
 *   is what stops guessing one account's password from many addresses; it cannot be got around by changing address.
 * - Per client address: 30 failed sign-ins in 15 minutes, across usernames, stop that address (password spraying).
 *   The address comes from `requestClientAddress` (`lib/auth/client-address.ts`): the TCP peer, or Caddy's
 *   `X-Forwarded-For` when the peer is Caddy, so an app behind its doorway cannot send its way around it. Loopback
 *   and an unknown address are not client addresses (null): a limit on them would let anyone lock everyone out.
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
  /** Failures left in this window after this one, the smaller of the username's and the address's (0 when refused). */
  remaining: number;
  usernameKey: string;
  addressKey: string | null;
  /** Set once a success or a non-guess has settled the attempt; a second settlement does nothing. */
  settled?: boolean;
}

export type SignInScope = 'id-login' | 'cp-login' | 'appliance-claim';

function usernameKey(scope: SignInScope, username: string): string {
  return `${scope}-user:${username.trim().toLowerCase().slice(0, 256)}`;
}

/** Check both limits and, when the attempt may go ahead, count it against both. */
export function beginSignInAttempt(
  username: string,
  address: string | null,
  scope: SignInScope = 'id-login',
): SignInAttempt {
  const userKey = usernameKey(scope, username);
  const addressKey = address ? `${scope}-address:${address}` : null;
  const refusals = [
    isRateLimited(userKey, SIGN_IN_USERNAME_ATTEMPTS),
    ...(addressKey ? [isRateLimited(addressKey, SIGN_IN_ADDRESS_ATTEMPTS)] : []),
  ].filter((state) => state.limited);
  if (refusals.length > 0) {
    return {
      allowed: false,
      retryAt: Math.max(...refusals.map((state) => state.resetAt)),
      remaining: 0,
      usernameKey: userKey,
      addressKey,
    };
  }
  const byUser = checkRateLimit(userKey, SIGN_IN_USERNAME_ATTEMPTS, SIGN_IN_WINDOW_SECONDS);
  const byAddress = addressKey ? checkRateLimit(addressKey, SIGN_IN_ADDRESS_ATTEMPTS, SIGN_IN_WINDOW_SECONDS) : null;
  const remaining = Math.min(byUser.remaining, byAddress?.remaining ?? Infinity);
  return { allowed: true, retryAt: 0, remaining, usernameKey: userKey, addressKey };
}

/** After a successful sign-in: the username starts over, and the address gets its attempt back. */
export function signInSucceeded(attempt: SignInAttempt): void {
  if (!attempt.allowed || attempt.settled) return;
  attempt.settled = true;
  resetRateLimit(attempt.usernameKey);
  if (attempt.addressKey) refundRateLimit(attempt.addressKey);
}

/** An attempt that was no guess (a form error found before any password was checked): it counts against nothing. */
export function signInNotCounted(attempt: SignInAttempt): void {
  if (!attempt.allowed || attempt.settled) return;
  attempt.settled = true;
  refundRateLimit(attempt.usernameKey);
  if (attempt.addressKey) refundRateLimit(attempt.addressKey);
}
