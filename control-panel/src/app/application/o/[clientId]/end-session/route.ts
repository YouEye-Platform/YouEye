import { NextRequest, NextResponse } from 'next/server';
import { getIdentityConfig } from '@/lib/identity/config';
import { getClient, revokeIdentitySession } from '@/lib/identity/store';
import { getIdentitySession, getIdentitySessionId } from '@/lib/identity/http';
import { SESSION_COOKIE, verifyClientIdToken } from '@/lib/identity/tokens';
import { queueSessionLogout } from '@/lib/identity/backchannel-logout';
import { identitySearchParams } from '@/lib/identity/authorize-query';

export async function GET(request: NextRequest, { params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await params;
  const client = await getClient(clientId);
  if (!client) return NextResponse.json({ error: 'unknown_client' }, { status: 404 });
  const config = await getIdentityConfig();
  const query = identitySearchParams(request);
  const requestedRedirect = query.get('post_logout_redirect_uri');
  if (requestedRedirect && !client.post_logout_redirect_uris.includes(requestedRedirect)) {
    return NextResponse.json({ error: 'invalid_post_logout_redirect_uri' }, { status: 400 });
  }
  const hint = query.get('id_token_hint');
  const hinted = hint ? await verifyClientIdToken(hint, clientId) : null;
  if (hint && !hinted) return NextResponse.json({ error: 'invalid_id_token_hint' }, { status: 400 });
  const currentUser = await getIdentitySession(request);
  const currentSessionId = await getIdentitySessionId(request);
  if (hinted && currentUser && hinted.sub !== currentUser.id) {
    return NextResponse.json({ error: 'session_mismatch' }, { status: 400 });
  }
  if (hinted?.sid && currentSessionId && hinted.sid !== currentSessionId) {
    return NextResponse.json({ error: 'session_mismatch' }, { status: 400 });
  }
  if (hinted && !currentSessionId) {
    return NextResponse.json({ error: 'session_mismatch' }, { status: 400 });
  }
  if (currentSessionId) {
    await queueSessionLogout(currentSessionId);
    await revokeIdentitySession(currentSessionId);
  }
  const redirect = new URL(requestedRedirect || config.externalUrl);
  const state = query.get('state');
  if (state && requestedRedirect) redirect.searchParams.set('state', state);
  const response = NextResponse.redirect(redirect);
  response.cookies.set(SESSION_COOKIE, '', {
    domain: config.cookieDomain, path: '/', maxAge: 0,
    httpOnly: true, secure: process.env.SECURE_COOKIES !== 'false', sameSite: 'lax',
  });
  return response;
}
