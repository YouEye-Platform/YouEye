import { NextRequest, NextResponse } from 'next/server';
import { createAuthCode, getAppConsent, getClient, upsertAppConsent, type IdentityClient, type IdentityUser } from '@/lib/identity/store';
import { getIdentityConfig } from '@/lib/identity/config';
import { getIdentitySession } from '@/lib/identity/http';

const FIRST_PARTY_CLIENTS = new Set(['youeye-control', 'youeye-ui']);
const DEFAULT_SCOPE = 'openid profile email';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function scopeList(scope: string): string[] {
  return Array.from(new Set(scope.split(/\s+/).map((item) => item.trim()).filter(Boolean)));
}

function isFirstPartyClient(clientId: string): boolean {
  return FIRST_PARTY_CLIENTS.has(clientId);
}

function hasScopes(consented: string[], requested: string[]): boolean {
  const granted = new Set(consented);
  return requested.every((scope) => granted.has(scope));
}

async function issueAuthRedirect(input: {
  clientId: string;
  user: IdentityUser;
  redirectUri: string;
  scope: string;
  state: string;
}) {
  const code = await createAuthCode({
    clientId: input.clientId,
    userId: input.user.id,
    redirectUri: input.redirectUri,
    scope: input.scope,
  });
  const redirect = new URL(input.redirectUri);
  redirect.searchParams.set('code', code);
  if (input.state) redirect.searchParams.set('state', input.state);
  return NextResponse.redirect(redirect);
}

function denyRedirect(redirectUri: string, state: string) {
  const redirect = new URL(redirectUri);
  redirect.searchParams.set('error', 'access_denied');
  redirect.searchParams.set('error_description', 'The user denied this app request.');
  if (state) redirect.searchParams.set('state', state);
  return NextResponse.redirect(redirect, { status: 303 });
}

function consentHtml(params: {
  client: IdentityClient;
  user: IdentityUser;
  scope: string;
  query: string;
}) {
  const scopes = scopeList(params.scope);
  const appName = params.client.name || params.client.client_id;
  const permissionRows = scopes.map((scope) => {
    const label = scope === 'openid'
      ? 'Sign you in with YouEye ID'
      : scope === 'profile'
        ? 'Read your profile name'
        : scope === 'email'
          ? 'Read your email address'
          : `Use ${scope}`;
    return `<li><span>${escapeHtml(label)}</span><code>${escapeHtml(scope)}</code></li>`;
  }).join('');

  return new Response(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <link rel="icon" href="data:," />
  <title>Allow ${escapeHtml(appName)}?</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: Canvas; color: CanvasText; }
    main { width: min(440px, calc(100vw - 32px)); }
    h1 { font-size: 24px; line-height: 1.15; margin: 0 0 8px; }
    p { margin: 0 0 20px; color: color-mix(in srgb, CanvasText 68%, transparent); line-height: 1.45; }
    ul { list-style: none; margin: 0 0 22px; padding: 0; display: grid; gap: 8px; }
    li { display: flex; justify-content: space-between; gap: 12px; align-items: center; border: 1px solid color-mix(in srgb, CanvasText 16%, transparent); border-radius: 8px; padding: 10px 12px; }
    code { color: color-mix(in srgb, CanvasText 58%, transparent); font-size: 12px; }
    form { display: flex; gap: 10px; }
    button { height: 42px; border-radius: 8px; font: inherit; font-weight: 700; cursor: pointer; padding: 0 16px; }
    .approve { border: 0; background: #111; color: #fff; flex: 1; }
    .deny { border: 1px solid color-mix(in srgb, CanvasText 18%, transparent); background: Canvas; color: CanvasText; }
    .account { font-size: 13px; margin-bottom: 16px; }
  </style>
</head>
<body>
  <main>
    <h1>Allow ${escapeHtml(appName)}?</h1>
    <p class="account">Signed in as ${escapeHtml(params.user.name || params.user.username)}.</p>
    <p>This app wants to use YouEye ID for your account. You can revoke this later from app settings.</p>
    <ul>${permissionRows}</ul>
    <form method="post" action="/application/o/authorize?${escapeHtml(params.query)}">
      <button class="deny" type="submit" name="decision" value="deny">Deny</button>
      <button class="approve" type="submit" name="decision" value="approve">Allow</button>
    </form>
  </main>
</body>
</html>`, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

async function validateAuthorizeRequest(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const responseType = params.get('response_type');
  const clientId = params.get('client_id') || '';
  const redirectUri = params.get('redirect_uri') || '';
  const state = params.get('state') || '';
  const scope = params.get('scope') || DEFAULT_SCOPE;

  if (responseType !== 'code') {
    return { error: NextResponse.json({ error: 'unsupported_response_type' }, { status: 400 }) };
  }
  const client = await getClient(clientId);
  if (!client) {
    return { error: NextResponse.json({ error: 'invalid_client' }, { status: 400 }) };
  }
  if (!client.redirect_uris.includes(redirectUri)) {
    return { error: NextResponse.json({ error: 'invalid_redirect_uri' }, { status: 400 }) };
  }

  return { client, clientId, redirectUri, state, scope };
}

export async function GET(request: NextRequest) {
  const config = await getIdentityConfig();
  const user = await getIdentitySession(request);
  if (!user) {
    const returnUrl = new URL(request.nextUrl.pathname + request.nextUrl.search, config.externalUrl);
    const returnTo = encodeURIComponent(returnUrl.toString());
    return NextResponse.redirect(`${config.externalUrl}/identity/login?return_to=${returnTo}`);
  }

  const validated = await validateAuthorizeRequest(request);
  if ('error' in validated) return validated.error;
  const { client, clientId, redirectUri, state, scope } = validated;

  if (!isFirstPartyClient(clientId)) {
    const requestedScopes = scopeList(scope);
    const consent = await getAppConsent(user.id, clientId);
    if (!consent || !hasScopes(consent.scopes, requestedScopes)) {
      return consentHtml({
        client,
        user,
        scope,
        query: request.nextUrl.searchParams.toString(),
      });
    }
  }

  return issueAuthRedirect({ clientId, user, redirectUri, scope, state });
}

export async function POST(request: NextRequest) {
  const user = await getIdentitySession(request);
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const validated = await validateAuthorizeRequest(request);
  if ('error' in validated) return validated.error;
  const { clientId, redirectUri, state, scope } = validated;

  const form = await request.formData();
  const decision = String(form.get('decision') || '');
  if (decision !== 'approve') {
    return denyRedirect(redirectUri, state);
  }

  await upsertAppConsent({ userId: user.id, clientId, scopes: scopeList(scope) });
  return issueAuthRedirect({ clientId, user, redirectUri, scope, state });
}
