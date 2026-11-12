import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getSession, verifyCSRFToken, checkRateLimit, resetRateLimit } from '@/lib/auth/session';
import { verifyUser } from '@/lib/identity/store';
import { createOAuthClient } from '@/lib/identity/provider';
import { validatePublicClientRegistration } from '@/lib/identity/public-client';

/** Administrator-provisioned native client. Registration never returns a shared secret. */
export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session?.isAdmin || session.authMethod !== 'sso') {
    return NextResponse.json({ error: 'Admin sign-in required' }, { status: 403 });
  }
  if (!await verifyCSRFToken(request.headers.get('X-CSRF-Token') || '')) {
    return NextResponse.json({ error: 'Invalid CSRF token' }, { status: 403 });
  }
  const body = await request.json().catch(() => null);
  const registration = validatePublicClientRegistration(body);
  if (!registration) return NextResponse.json({ error: 'Invalid client name or redirect URI' }, { status: 400 });
  const limitKey = `public-client-registration:${session.username}`;
  if (!checkRateLimit(limitKey, 6, 15 * 60).allowed) {
    return NextResponse.json({ error: 'Too many password attempts' }, { status: 429 });
  }
  const password = body && typeof body.password === 'string' ? body.password : '';
  const user = await verifyUser(session.username, password);
  if (!user?.is_admin || (session.identityId && session.identityId !== user.id)) {
    return NextResponse.json({ error: 'Current password is incorrect' }, { status: 403 });
  }
  resetRateLimit(limitKey);
  const clientId = `youeye-public-${randomUUID()}`;
  await createOAuthClient({ clientId, name: registration.name, redirectUris: registration.redirectUris,
    publicClient: true, scopes: ['openid', 'profile', 'email'] });
  return NextResponse.json({ clientId, name: registration.name, redirectUris: registration.redirectUris,
    tokenEndpointAuthMethod: 'none', codeChallengeMethod: 'S256' },
  { status: 201, headers: { 'Cache-Control': 'no-store' } });
}
