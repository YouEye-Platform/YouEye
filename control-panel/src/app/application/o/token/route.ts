import { NextRequest, NextResponse } from 'next/server';
import { createHash, timingSafeEqual } from 'crypto';
import {
  consumeAuthCode, getClient, getIdentitySessionById, getUserById,
  issueRefreshToken, rotateRefreshToken,
} from '@/lib/identity/store';
import { createAccessToken, createIdToken } from '@/lib/identity/tokens';

function secretsMatch(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function credentials(request: NextRequest, form: FormData): { clientId: string; clientSecret: string } {
  const authorization = request.headers.get('authorization');
  if (authorization) {
    const basic = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(authorization)?.[1];
    if (!basic) return { clientId: '', clientSecret: '' };
    try {
      const decoded = Buffer.from(basic, 'base64').toString('utf8');
      const index = decoded.indexOf(':');
      if (index >= 0) return { clientId: decoded.slice(0, index), clientSecret: decoded.slice(index + 1) };
    } catch { /* invalid Basic credentials */ }
    return { clientId: '', clientSecret: '' };
  }
  return { clientId: String(form.get('client_id') || ''), clientSecret: String(form.get('client_secret') || '') };
}

function pkceMatches(challenge: string | null, verifier: string): boolean {
  if (!challenge) return !verifier;
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  const actual = createHash('sha256').update(verifier).digest('base64url');
  return secretsMatch(challenge, actual);
}

export async function POST(request: NextRequest) {
  const form = await request.formData();
  const grantType = String(form.get('grant_type') || '');
  const { clientId, clientSecret } = credentials(request, form);
  const client = await getClient(clientId);
  if (!client || (client.client_secret ? !secretsMatch(client.client_secret, clientSecret) : Boolean(clientSecret))) {
    return NextResponse.json({ error: 'invalid_client' }, { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="youeye-id"' } });
  }

  if (grantType === 'refresh_token') {
    const rotated = await rotateRefreshToken(String(form.get('refresh_token') || ''), clientId);
    if (!rotated) return NextResponse.json({ error: 'invalid_grant' }, { status: 400 });
    const user = await getUserById(rotated.userId);
    if (!user?.is_active) return NextResponse.json({ error: 'invalid_grant' }, { status: 400 });
    const [accessToken, idToken] = await Promise.all([
      createAccessToken(user, clientId, rotated.scope, rotated.sessionId),
      createIdToken(user, clientId, rotated.scope, null, rotated.sessionId),
    ]);
    return NextResponse.json({ access_token: accessToken, id_token: idToken, refresh_token: rotated.token, token_type: 'Bearer', expires_in: 3600, scope: rotated.scope });
  }

  if (grantType !== 'authorization_code') return NextResponse.json({ error: 'unsupported_grant_type' }, { status: 400 });
  const code = String(form.get('code') || '');
  const redirectUri = String(form.get('redirect_uri') || '');
  const authCode = await consumeAuthCode(code, clientId, redirectUri);
  if (!authCode || !pkceMatches(authCode.code_challenge, String(form.get('code_verifier') || '')) || (!client.client_secret && !authCode.code_challenge)) {
    return NextResponse.json({ error: 'invalid_grant' }, { status: 400 });
  }
  if (authCode.session_id && !(await getIdentitySessionById(authCode.session_id))) {
    return NextResponse.json({ error: 'invalid_grant' }, { status: 400 });
  }
  const user = await getUserById(authCode.user_id);
  if (!user?.is_active) return NextResponse.json({ error: 'invalid_grant' }, { status: 400 });
  const [accessToken, idToken, refreshToken] = await Promise.all([
    createAccessToken(user, clientId, authCode.scope, authCode.session_id),
    createIdToken(user, clientId, authCode.scope, authCode.nonce, authCode.session_id),
    authCode.session_id ? issueRefreshToken({ clientId, userId: user.id, sessionId: authCode.session_id, scope: authCode.scope }) : Promise.resolve(null),
  ]);
  return NextResponse.json({ access_token: accessToken, id_token: idToken, ...(refreshToken ? { refresh_token: refreshToken } : {}), token_type: 'Bearer', expires_in: 3600, scope: authCode.scope });
}
