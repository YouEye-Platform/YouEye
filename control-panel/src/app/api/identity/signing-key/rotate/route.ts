import { NextRequest, NextResponse } from 'next/server';
import { getSession, verifyCSRFToken, checkRateLimit, resetRateLimit } from '@/lib/auth/session';
import { verifyUser } from '@/lib/identity/store';
import { getOAuthKeyId, rotateOAuthKey } from '@/lib/identity/tokens';

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session?.isAdmin || session.authMethod !== 'sso') {
    return NextResponse.json({ error: 'Admin sign-in required' }, { status: 403 });
  }
  if (!await verifyCSRFToken(request.headers.get('X-CSRF-Token') || '')) {
    return NextResponse.json({ error: 'Invalid CSRF token' }, { status: 403 });
  }
  const limitKey = `signing-key-rotation:${session.username}`;
  const limit = checkRateLimit(limitKey, 6, 15 * 60);
  if (!limit.allowed) return NextResponse.json({ error: 'Too many password attempts' }, { status: 429 });
  const body = await request.json().catch(() => ({}));
  const user = await verifyUser(session.username, typeof body.password === 'string' ? body.password : '');
  if (!user?.is_admin || (session.identityId && session.identityId !== user.id)) {
    return NextResponse.json({ error: 'Current password is incorrect' }, { status: 403 });
  }
  resetRateLimit(limitKey);
  const previousKid = await getOAuthKeyId();
  const currentKid = await rotateOAuthKey();
  return NextResponse.json({ previousKid, currentKid, overlapHours: 48 }, { headers: { 'Cache-Control': 'no-store' } });
}
