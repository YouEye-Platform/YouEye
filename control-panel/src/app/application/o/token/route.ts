import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { consumeAuthCode, getClient, getUserById } from '@/lib/identity/store';
import { createAccessToken } from '@/lib/identity/tokens';

function secretsMatch(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Resolve client credentials from EITHER the HTTP Basic Authorization header
 * (client_secret_basic) or the request body (client_secret_post). Many OIDC
 * client libraries default to Basic (Authlib, openid-client, mod_auth_openidc,
 * Spring Security, the Rust openidconnect crate); others post the credentials
 * in the body. We accept both — RFC 6749 §2.3.1. Basic wins when present.
 */
function extractClientCredentials(
  request: NextRequest,
  form: FormData,
): { clientId: string; clientSecret: string } {
  const basic = (request.headers.get('authorization') || '').match(/^Basic\s+(.+)$/i)?.[1];
  if (basic) {
    try {
      const decoded = Buffer.from(basic, 'base64').toString('utf8');
      const sep = decoded.indexOf(':');
      if (sep >= 0) {
        return { clientId: decoded.slice(0, sep), clientSecret: decoded.slice(sep + 1) };
      }
    } catch {
      // Malformed Basic header — fall back to body credentials below.
    }
  }
  return {
    clientId: String(form.get('client_id') || ''),
    clientSecret: String(form.get('client_secret') || ''),
  };
}

export async function POST(request: NextRequest) {
  const form = await request.formData();
  const grantType = String(form.get('grant_type') || '');
  const code = String(form.get('code') || '');
  const redirectUri = String(form.get('redirect_uri') || '');
  const { clientId, clientSecret } = extractClientCredentials(request, form);

  if (grantType !== 'authorization_code') {
    return NextResponse.json({ error: 'unsupported_grant_type' }, { status: 400 });
  }
  const client = await getClient(clientId);
  if (!client || !secretsMatch(client.client_secret, clientSecret)) {
    return NextResponse.json(
      { error: 'invalid_client' },
      { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="youeye-id"' } },
    );
  }
  const authCode = await consumeAuthCode(code, clientId, redirectUri);
  if (!authCode) {
    return NextResponse.json({ error: 'invalid_grant' }, { status: 400 });
  }
  const user = await getUserById(authCode.user_id);
  if (!user) {
    return NextResponse.json({ error: 'invalid_grant' }, { status: 400 });
  }

  const accessToken = await createAccessToken(user, clientId, authCode.scope, authCode.nonce);
  return NextResponse.json({
    access_token: accessToken,
    id_token: accessToken,
    token_type: 'Bearer',
    expires_in: 3600,
    scope: authCode.scope,
  });
}
