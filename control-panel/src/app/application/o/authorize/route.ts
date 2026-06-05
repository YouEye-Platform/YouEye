import { NextRequest, NextResponse } from 'next/server';
import { createAuthCode, getClient } from '@/lib/identity/store';
import { getIdentityConfig } from '@/lib/identity/config';
import { getIdentitySession } from '@/lib/identity/http';

export async function GET(request: NextRequest) {
  const config = await getIdentityConfig();
  const user = await getIdentitySession(request);
  if (!user) {
    const returnTo = encodeURIComponent(request.nextUrl.toString());
    return NextResponse.redirect(`${config.externalUrl}/identity/login?return_to=${returnTo}`);
  }

  const params = request.nextUrl.searchParams;
  const responseType = params.get('response_type');
  const clientId = params.get('client_id') || '';
  const redirectUri = params.get('redirect_uri') || '';
  const state = params.get('state') || '';
  const scope = params.get('scope') || 'openid profile email';

  if (responseType !== 'code') {
    return NextResponse.json({ error: 'unsupported_response_type' }, { status: 400 });
  }
  const client = await getClient(clientId);
  if (!client) {
    return NextResponse.json({ error: 'invalid_client' }, { status: 400 });
  }
  if (!client.redirect_uris.includes(redirectUri)) {
    return NextResponse.json({ error: 'invalid_redirect_uri' }, { status: 400 });
  }

  const code = await createAuthCode({ clientId, userId: user.id, redirectUri, scope });
  const redirect = new URL(redirectUri);
  redirect.searchParams.set('code', code);
  if (state) redirect.searchParams.set('state', state);
  return NextResponse.redirect(redirect);
}

