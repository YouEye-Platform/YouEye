import { NextRequest, NextResponse } from 'next/server';
import { createAuthCode, getAppConsent, getClient, upsertAppConsent, type IdentityClient, type IdentityUser } from '@/lib/identity/store';
import { getIdentityConfig } from '@/lib/identity/config';
import { getIdentityProviderConfig } from '@/lib/identity/provider';
import { getIdentitySession } from '@/lib/identity/http';
import { readFileSync } from 'fs';
import { CONTAINER_DOMAIN } from '@/lib/market/constants';

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

interface RuntimePermission {
  permission: string;
  title: string;
  description?: string;
  category?: string;
  risk?: string;
}

function appIdFromClientId(clientId: string): string | null {
  if (clientId.startsWith('youeye-app-')) return clientId.slice('youeye-app-'.length).replace(/^ye-/, '');
  if (clientId.startsWith('ye-')) return clientId.slice('ye-'.length);
  return null;
}

function readBridgeToken(): string | null {
  try {
    return readFileSync('/etc/youeye/ui-bridge-token', 'utf-8').trim();
  } catch {
    return process.env.UI_BRIDGE_TOKEN ?? null;
  }
}

function uiBaseUrl(): string {
  return process.env.UI_INTERNAL_URL || `http://youeye-ui.${CONTAINER_DOMAIN}:3000`;
}

async function fetchRuntimePermissions(input: {
  clientId: string;
  user: IdentityUser;
  grantPermissions?: string[];
}): Promise<{ appId: string; permissions: RuntimePermission[] } | null> {
  const appId = appIdFromClientId(input.clientId);
  const token = readBridgeToken();
  if (!appId || !token) return null;

  try {
    const res = await fetch(`${uiBaseUrl()}/api/ui-bridge/app-launch-permissions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-UI-Bridge-Token': token,
      },
      body: JSON.stringify({
        appId,
        identityUserId: input.user.id,
        username: input.user.username,
        email: input.user.email,
        grantPermissions: input.grantPermissions ?? [],
        denyUnselected: Array.isArray(input.grantPermissions),
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`UI bridge returned ${res.status}${detail ? `: ${detail.slice(0, 240)}` : ''}`);
    }
    const data = await res.json();
    return {
      appId,
      permissions: Array.isArray(data.permissions) ? data.permissions : [],
    };
  } catch (err) {
    console.warn('[identity] Failed to fetch runtime launch permissions:', err);
    return null;
  }
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
  return NextResponse.redirect(redirect, { status: 303 });
}

function denyRedirect(redirectUri: string, state: string) {
  const redirect = new URL(redirectUri);
  redirect.searchParams.set('error', 'access_denied');
  redirect.searchParams.set('error_description', 'The user denied this app request.');
  if (state) redirect.searchParams.set('state', state);
  return NextResponse.redirect(redirect, { status: 303 });
}

function initials(value: string): string {
  const letters = value
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('');
  return letters || 'A';
}

function consentHtml(params: {
  client: IdentityClient;
  user: IdentityUser;
  scope: string;
  query: string;
  providerName: string;
  runtimePermissions?: RuntimePermission[];
}) {
  const scopes = scopeList(params.scope);
  const appName = params.client.name || params.client.client_id;
  const runtimeRows = (params.runtimePermissions ?? []).map((permission) => {
    return `<label class="runtime-permission">
      <input type="checkbox" name="runtime_permission" value="${escapeHtml(permission.permission)}" checked />
      <span class="switch" aria-hidden="true"></span>
      <span>
        <strong>${escapeHtml(permission.title || permission.permission)}</strong>
        ${permission.description ? `<small>${escapeHtml(permission.description)}</small>` : ''}
      </span>
    </label>`;
  }).join('');
  const runtimeSection = runtimeRows
    ? `<section class="extra-access"><p>${escapeHtml(appName)} also wants to:</p><div class="runtime-list">${runtimeRows}</div></section>`
    : '';
  const accountLabel = params.user.name || params.user.username;
  const accountEmail = params.user.email || params.user.username;
  const shares = [
    scopes.includes('profile') ? 'name' : null,
    scopes.includes('email') ? 'email address' : null,
  ].filter(Boolean) as string[];
  const shareText = shares.length > 0
    ? `${params.providerName} will share your ${shares.join(' and ')} with ${appName}.`
    : `${params.providerName} will let ${appName} confirm this is your account.`;

  return new Response(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <link rel="icon" href="data:," />
  <title>Allow ${escapeHtml(appName)}?</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 24px;
      background:
        linear-gradient(180deg, rgba(255,255,255,.62), rgba(255,255,255,.86)),
        linear-gradient(135deg, #eaf8f6 0%, #eff7ff 48%, #f8fbff 100%);
      color: #17191c;
    }
    main {
      width: min(520px, 100%);
      border: 1px solid rgba(24, 36, 48, .12);
      border-radius: 8px;
      background: rgba(255,255,255,.94);
      box-shadow: 0 22px 54px rgba(28, 52, 70, .14);
      padding: 22px;
    }
    h1 { margin: 0; font-size: 1.55rem; line-height: 1.18; letter-spacing: 0; text-align: center; }
    p { margin: 0; color: #627183; line-height: 1.45; }
    .provider {
      display: grid;
      justify-items: center;
      gap: 8px;
      margin-bottom: 18px;
      text-align: center;
    }
    .mark {
      display: grid;
      place-items: center;
      width: 52px;
      height: 52px;
      border-radius: 16px;
      border: 1px solid #d8e6ef;
      background: linear-gradient(135deg, #f7fcfb 0%, #eef7ff 100%);
      color: #126cc6;
      font-size: 18px;
      font-weight: 900;
    }
    .provider-name { color: #2c3440; font-size: 13px; font-weight: 800; }
    .intro { display: grid; gap: 8px; margin-bottom: 18px; text-align: center; }
    .account {
      display: flex;
      align-items: center;
      gap: 10px;
      border: 1px solid #e1e8ef;
      border-radius: 8px;
      background: #fbfdff;
      padding: 10px 12px;
      margin-bottom: 18px;
    }
    .avatar {
      display: grid;
      place-items: center;
      width: 38px;
      height: 38px;
      border-radius: 999px;
      background: #e8f3ff;
      color: #126cc6;
      font-size: 13px;
      font-weight: 900;
      flex: 0 0 auto;
    }
    .account-main { min-width: 0; flex: 1; }
    .account-main strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; }
    .account-main span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #64717f; font-size: 12px; margin-top: 2px; }
    .copy { display: grid; gap: 8px; margin-bottom: 18px; text-align: center; }
    .copy p { font-size: 14px; }
    .extra-access { margin-bottom: 18px; display: grid; gap: 9px; }
    .extra-access > p { color: #2c3440; font-size: 13px; font-weight: 800; }
    .runtime-list { display: grid; gap: 8px; }
    .runtime-permission { display: grid; grid-template-columns: auto 1fr auto; gap: 10px; align-items: center; border: 1px solid #e1e8ef; border-radius: 8px; padding: 10px 12px; cursor: pointer; background: #fff; }
    .runtime-permission input { position: absolute; opacity: 0; pointer-events: none; }
    .switch { width: 38px; height: 22px; border-radius: 999px; background: #cbd5e1; position: relative; transition: background .16s ease; }
    .switch::after { content: ""; position: absolute; top: 3px; left: 3px; width: 16px; height: 16px; border-radius: 999px; background: #fff; box-shadow: 0 1px 2px rgba(15,23,42,.2); transition: transform .16s ease; }
    .runtime-permission input:checked + .switch { background: #0b84ff; }
    .runtime-permission input:checked + .switch::after { transform: translateX(16px); }
    .runtime-permission strong { display: block; color: #2c3440; font-size: 14px; font-weight: 800; }
    .runtime-permission small { display: block; margin-top: 3px; color: #64717f; font-size: 12px; line-height: 1.35; }
    form { display: grid; gap: 0; }
    .actions { display: flex; gap: 10px; }
    button { height: 42px; border-radius: 8px; font: inherit; font-weight: 700; cursor: pointer; padding: 0 16px; }
    .approve { border: 0; background: #0b84ff; color: #fff; flex: 1; }
    .deny { border: 1px solid #d6e1ea; background: #fff; color: #405061; }
    @media (max-width: 460px) {
      main { padding: 18px; }
      .actions { flex-direction: column-reverse; }
      .runtime-permission { grid-template-columns: auto 1fr; }
    }
  </style>
</head>
<body>
  <main>
    <div class="provider" aria-label="${escapeHtml(params.providerName)}">
      <div class="mark">${escapeHtml(initials(params.providerName))}</div>
      <div class="provider-name">${escapeHtml(params.providerName)}</div>
    </div>
    <div class="intro">
      <h1>Sign in to ${escapeHtml(appName)}</h1>
    </div>
    <div class="account">
      <div class="avatar">${escapeHtml(initials(accountLabel))}</div>
      <div class="account-main">
        <strong>${escapeHtml(accountLabel)}</strong>
        <span>${escapeHtml(accountEmail)}</span>
      </div>
    </div>
    <div class="copy">
      <p>${escapeHtml(shareText)}</p>
      <p>You can revoke access later in app settings.</p>
    </div>
    <form method="post" action="/application/o/authorize?${escapeHtml(params.query)}">
      ${runtimeSection}
      <div class="actions">
        <button class="deny" type="submit" name="decision" value="deny">Cancel</button>
        <button class="approve" type="submit" name="decision" value="approve">Continue</button>
      </div>
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
  const provider = await getIdentityProviderConfig();
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
    const runtime = await fetchRuntimePermissions({ clientId, user });
    if (!consent || !hasScopes(consent.scopes, requestedScopes) || (runtime?.permissions.length ?? 0) > 0) {
      return consentHtml({
        client,
        user,
        scope,
        query: request.nextUrl.searchParams.toString(),
        providerName: provider.name,
        runtimePermissions: runtime?.permissions,
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

  const selectedRuntimePermissions = form.getAll('runtime_permission')
    .map((value) => String(value))
    .filter(Boolean);
  const runtime = await fetchRuntimePermissions({
    clientId,
    user,
    grantPermissions: selectedRuntimePermissions,
  });
  if (!runtime) {
    return NextResponse.json({ error: 'failed_to_update_app_permissions' }, { status: 502 });
  }

  await upsertAppConsent({ userId: user.id, clientId, scopes: scopeList(scope) });
  return issueAuthRedirect({ clientId, user, redirectUri, scope, state });
}
