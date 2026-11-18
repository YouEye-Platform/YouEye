/**
 * Where a Market page sends an owner who is not signed in, keeping the page and its query (an "Add to YouEye" link)
 * as the return path: the same as the proxy's sign-in redirect for `/market` and `/settings` (`loginRedirectFor` in
 * proxy.ts). Market pages are Settings pages there, so sign-in goes through `/settings/api/auth/sso` (on the box's own
 * name Caddy sends a bare `/api/auth/sso` to the dashboard, which would never renew the Control Panel's session) and
 * the password sign-in is `/settings/login`. The return path is checked again by the sign-in route (`safeOAuthReturn`).
 */
import { withSettingsBase } from '@/lib/settings-public-path';

/** The longest return path the sign-in route keeps (`safeOAuthReturn` in shared/oauth-transaction.ts). */
export const MAX_SIGN_IN_RETURN_PATH = 2048;

/** A sign-in attempt for the same page newer than this means the attempt came back without a session. */
export const SIGN_IN_RETRY_WINDOW_MS = 2 * 60 * 1000;

/** The `sessionStorage` key of the last automatic sign-in attempt from a Market page. */
export const SIGN_IN_ATTEMPT_KEY = 'youeye.market.sign-in-attempt';

export function marketSignInLocation(sso: boolean, pathname: string, search: string): string {
  return sso
    ? `${withSettingsBase('/api/auth/sso')}?redirect=${encodeURIComponent(`${pathname}${search}`)}`
    : withSettingsBase('/login');
}

/** What the Market shell does for a signed-out owner. */
export type SignInStep =
  | { kind: 'redirect'; location: string; attempt: string }
  | { kind: 'link'; location: string; reason: 'returned' | 'too-long' };

/** The marker of one automatic sign-in attempt for `returnTo` (stored in `sessionStorage`). */
export function signInAttempt(returnTo: string, now: number): string {
  return JSON.stringify({ returnTo, at: now });
}

function attemptedRecently(stored: string | null, returnTo: string, now: number): boolean {
  if (!stored) return false;
  try {
    const parsed = JSON.parse(stored) as { returnTo?: unknown; at?: unknown };
    return parsed.returnTo === returnTo && typeof parsed.at === 'number'
      && now - parsed.at >= 0 && now - parsed.at < SIGN_IN_RETRY_WINDOW_MS;
  } catch {
    return false;
  }
}

/**
 * Redirect to sign-in once; when the page is back from an attempt for the same address within the retry window (the
 * sign-in did not give this page a session), show a plain sign-in link instead, so a failing sign-in can never reload
 * the page without end. A return path the sign-in route would drop (too long) is never redirected either: the link
 * would be lost silently. `stored` is the `sessionStorage` marker, or undefined when storage cannot be used (then
 * nothing can tell a first visit from a return, so the owner clicks).
 */
export function marketSignInStep(
  sso: boolean, pathname: string, search: string, stored: string | null | undefined, now: number,
): SignInStep {
  const returnTo = `${pathname}${search}`;
  if (returnTo.length > MAX_SIGN_IN_RETURN_PATH) {
    return { kind: 'link', location: marketSignInLocation(sso, pathname, ''), reason: 'too-long' };
  }
  const location = marketSignInLocation(sso, pathname, search);
  if (stored === undefined || attemptedRecently(stored, returnTo, now)) return { kind: 'link', location, reason: 'returned' };
  return { kind: 'redirect', location, attempt: signInAttempt(returnTo, now) };
}
