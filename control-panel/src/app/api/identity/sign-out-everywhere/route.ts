import { NextRequest, NextResponse } from 'next/server';
import { checkRateLimit, clearSessionCookies, getSession, resetRateLimit, verifyCSRFToken } from '@/lib/auth/session';
import { revokeAllIdentitySessions, verifyUser } from '@/lib/identity/store';
import { getIdentityConfig } from '@/lib/identity/config';
import { SESSION_COOKIE } from '@/lib/identity/tokens';
import { queueUserLogout } from '@/lib/identity/backchannel-logout';

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session || session.authMethod !== 'sso') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!await verifyCSRFToken(request.headers.get('X-CSRF-Token') || '')) {
    return NextResponse.json({ error: 'Invalid CSRF token' }, { status: 403 });
  }
  const body = await request.json().catch(() => ({}));
  const password = typeof body.password === 'string' ? body.password : '';
  const limitKey = `global-signout:${session.username}`;
  const limit = checkRateLimit(limitKey, 6, 15 * 60);
  if (!limit.allowed) return NextResponse.json({ error: 'Too many password attempts. Try again later.' }, { status: 429 });
  const user = await verifyUser(session.username, password);
  if (!user || (session.identityId && user.id !== session.identityId)) {
    return NextResponse.json({ error: 'Current password is incorrect' }, { status: 403 });
  }
  resetRateLimit(limitKey);
  const queued = await queueUserLogout(user.id);
  await revokeAllIdentitySessions(user.id);
  await clearSessionCookies();
  const config = await getIdentityConfig();
  const response = NextResponse.json({ success: true, coordinatedLogoutQueued: queued });
  response.cookies.set(SESSION_COOKIE, '', {
    domain: config.cookieDomain, path: '/', maxAge: 0, httpOnly: true,
    secure: process.env.SECURE_COOKIES !== 'false', sameSite: 'lax',
  });
  return response;
}
