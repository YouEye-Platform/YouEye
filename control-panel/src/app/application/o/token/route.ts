import { NextRequest, NextResponse } from 'next/server';
import { consumeAuthCode, getClient, getUserById } from '@/lib/identity/store';
import { createAccessToken } from '@/lib/identity/tokens';

export async function POST(request: NextRequest) {
  const form = await request.formData();
  const grantType = String(form.get('grant_type') || '');
  const clientId = String(form.get('client_id') || '');
  const clientSecret = String(form.get('client_secret') || '');
  const code = String(form.get('code') || '');
  const redirectUri = String(form.get('redirect_uri') || '');

  if (grantType !== 'authorization_code') {
    return NextResponse.json({ error: 'unsupported_grant_type' }, { status: 400 });
  }
  const client = await getClient(clientId);
  if (!client || client.client_secret !== clientSecret) {
    return NextResponse.json({ error: 'invalid_client' }, { status: 401 });
  }
  const authCode = await consumeAuthCode(code, clientId, redirectUri);
  if (!authCode) {
    return NextResponse.json({ error: 'invalid_grant' }, { status: 400 });
  }
  const user = await getUserById(authCode.user_id);
  if (!user) {
    return NextResponse.json({ error: 'invalid_grant' }, { status: 400 });
  }

  const accessToken = await createAccessToken(user, clientId);
  return NextResponse.json({
    access_token: accessToken,
    id_token: accessToken,
    token_type: 'Bearer',
    expires_in: 3600,
    scope: authCode.scope,
  });
}

