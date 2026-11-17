import { NextResponse } from 'next/server';
import { clearSessionCookies, getSession, verifyCSRFToken, type SessionPayload } from '@/lib/auth';
import { setupOwnerIsCurrent } from '@/lib/identity/store';

/** The browser must claim the box or sign in again; the wizard goes to /login. */
export const SETUP_SIGN_IN_REQUIRED = 'setup_sign_in_required';

export type SetupSession = SessionPayload & { setupOwnerId: string; setupSessionId: string };

/**
 * The owner's setup session, with CSRF for mutations. A session issued before
 * the box was reset (its owner is no longer this box's owner) is cleared and
 * answered with 401, never mistaken for another browser's setup.
 */
export async function requireSetupSession(
  request: Request,
  options: { csrf?: boolean } = {},
): Promise<{ session: SetupSession; response?: undefined } | { response: Response; session?: undefined }> {
  const session = await getSession();
  if (!session?.isAdmin || session.authMethod !== 'setup' || !session.setupOwnerId || !session.setupSessionId) {
    return { response: NextResponse.json({ error: 'Sign in to continue setup.', code: SETUP_SIGN_IN_REQUIRED }, { status: 401 }) };
  }
  if (options.csrf !== false) {
    const csrfToken = request.headers.get('X-CSRF-Token');
    if (!csrfToken || !(await verifyCSRFToken(csrfToken))) {
      return { response: NextResponse.json({ error: 'Invalid CSRF token' }, { status: 403 }) };
    }
  }
  if (!(await setupOwnerIsCurrent(session.setupOwnerId))) {
    await clearSessionCookies();
    return {
      response: NextResponse.json({
        error: 'This setup sign-in is from before the server was reset. Sign in again.',
        code: SETUP_SIGN_IN_REQUIRED,
      }, { status: 401 }),
    };
  }
  return { session: session as SetupSession };
}
