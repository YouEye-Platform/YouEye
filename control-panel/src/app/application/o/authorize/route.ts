import { NextRequest, NextResponse } from 'next/server';
import { createAuthCode, getAppConsent, getClient, upsertAppConsent, type IdentityClient, type IdentityUser } from '@/lib/identity/store';
import { getIdentityConfig } from '@/lib/identity/config';
import { getIdentityProviderConfig } from '@/lib/identity/provider';
import { getIdentitySession } from '@/lib/identity/http';
import { readFileSync } from 'fs';
import { CONTAINER_DOMAIN } from '@/lib/market/constants';
import { settingsService } from '@/lib/settings';
import { renderIdentityErrorPage } from '@/lib/identity/error-page';

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

interface ConsentDisplay {
  app?: {
    id?: string;
    name?: string;
    icon?: string | null;
    icon_url?: string | null;
    header_display_mode?: string | null;
    branding_css?: Record<string, string | number | undefined> | null;
    branding_font_url?: string | null;
    branding_css_chars?: string[] | null;
    has_branding_override?: boolean;
  };
  user?: {
    id?: string;
    name?: string | null;
    username?: string | null;
    email?: string | null;
    avatar_url?: string | null;
    avatar_path?: string | null;
  };
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

async function uiExternalUrl(): Promise<string | null> {
  const env = process.env.UI_EXTERNAL_URL || process.env.BASE_URL || process.env.NEXTAUTH_URL;
  if (env) return env.replace(/\/$/, '');
  const raw = await settingsService.getRaw().catch(() => null);
  const domain = typeof raw?.domain === 'string' ? raw.domain.trim() : '';
  if (!domain) return null;
  const subdomains = raw?.subdomains && typeof raw.subdomains === 'object' ? raw.subdomains as Record<string, unknown> : {};
  const uiSub = typeof subdomains.ui === 'string' ? subdomains.ui.trim() : '';
  return `https://${uiSub ? `${uiSub}.` : ''}${domain}`;
}

async function fetchRuntimePermissions(input: {
  clientId: string;
  user: IdentityUser;
  grantPermissions?: string[];
}): Promise<{ appId: string; permissions: RuntimePermission[]; display?: ConsentDisplay } | null> {
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
      display: data.display && typeof data.display === 'object' ? data.display as ConsentDisplay : undefined,
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

function svgIcon(icon: string | null | undefined): string | null {
  switch ((icon || '').toLowerCase()) {
    case 'book-open':
      return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>';
    case 'search':
      return '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>';
    case 'sticky-note':
      return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15.5 3H5a2 2 0 0 0-2 2v14c0 1.1.9 2 2 2h14a2 2 0 0 0 2-2V8.5L15.5 3Z"/><path d="M14 3v4a2 2 0 0 0 2 2h4"/></svg>';
    case 'film':
      return '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="2" width="20" height="20" rx="2.18"/><path d="M7 2v20M17 2v20M2 12h20M2 7h5M2 17h5M17 7h5M17 17h5"/></svg>';
    case 'cloud-sun':
      return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2v2M4.93 4.93l1.41 1.41M20 12h2M19.07 4.93l-1.41 1.41"/><path d="M15.95 12.65a4 4 0 0 0-5.93-4.13"/><path d="M13 22H7a5 5 0 1 1 4.9-6H13a3 3 0 0 1 0 6Z"/></svg>';
    case 'languages':
      return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 8 6 6M4 14l6-6 2-3M2 5h12M7 2h1M22 22l-5-10-5 10M14 18h6"/></svg>';
    case 'cloud':
      return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/></svg>';
    case 'globe':
      return '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10A15.3 15.3 0 0 1 12 2Z"/></svg>';
    case 'package':
      return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7.5 4.27 9 5.15"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5M12 22V12"/></svg>';
    default:
      return null;
  }
}

function absoluteAssetUrl(value: string | null | undefined, baseUrl: string | null): string | null {
  if (!value) return null;
  if (value.startsWith('http://') || value.startsWith('https://') || value.startsWith('data:')) return value;
  if (value.startsWith('/') && baseUrl) return `${baseUrl}${value}`;
  return null;
}

function appIcon(display: ConsentDisplay['app'] | undefined, appName: string, baseUrl: string | null): string {
  const iconUrl = absoluteAssetUrl(display?.icon_url || display?.icon, baseUrl);
  if (iconUrl) {
    return `<span class="app-icon app-icon-image"><img src="${escapeHtml(iconUrl)}" alt="" /></span>`;
  }
  const icon = display?.icon || '';
  if (icon.startsWith('emoji:')) {
    return `<span class="app-icon app-icon-emoji" aria-hidden="true">${escapeHtml(icon.slice(6))}</span>`;
  }
  const svg = svgIcon(icon);
  if (svg) {
    return `<span class="app-icon app-icon-svg">${svg}</span>`;
  }
  return `<span class="app-icon app-icon-fallback">${escapeHtml(initials(appName).charAt(0))}</span>`;
}

function safeCssName(name: string): string {
  return name.replace(/([A-Z])/g, '-$1').toLowerCase();
}

function safeCssValue(value: unknown): string | null {
  if (typeof value === 'number') return String(value);
  if (typeof value !== 'string') return null;
  if (/[;{}<>]/.test(value)) return null;
  return value;
}

function styleObjectToInline(style: Record<string, string | number | undefined> | null | undefined): string {
  if (!style) return '';
  return Object.entries(style)
    .map(([key, value]) => {
      const safeValue = safeCssValue(value);
      return safeValue ? `${safeCssName(key)}:${safeValue}` : '';
    })
    .filter(Boolean)
    .join(';');
}

function appNameMarkup(display: ConsentDisplay['app'] | undefined, appName: string): string {
  const css = styleObjectToInline(display?.branding_css);
  const chars = display?.branding_css_chars;
  if (!css) return `<span class="app-name">${escapeHtml(appName)}</span>`;
  if (Array.isArray(chars) && chars.length > 0) {
    const parts = appName.split('').map((ch, index) => {
      const transform = safeCssValue(chars[index]) || 'none';
      const text = ch === ' ' ? '&nbsp;' : escapeHtml(ch);
      return `<span style="display:inline-block;transform:${escapeHtml(transform)}">${text}</span>`;
    }).join('');
    return `<span class="app-name app-name-branded" style="${escapeHtml(css)}">${parts}</span>`;
  }
  return `<span class="app-name app-name-branded" style="${escapeHtml(css)}">${escapeHtml(appName)}</span>`;
}

function appBrand(display: ConsentDisplay['app'] | undefined, appName: string, baseUrl: string | null): string {
  const mode = display?.header_display_mode || 'logo-text';
  const icon = mode === 'text-only' ? '' : appIcon(display, appName, baseUrl);
  const name = mode === 'logo-only' ? '' : appNameMarkup(display, appName);
  return `<div class="app-brand" aria-label="${escapeHtml(appName)}">${icon}${name}</div>`;
}

function accountAvatar(display: ConsentDisplay['user'] | undefined, accountLabel: string, baseUrl: string | null): string {
  const avatarUrl = absoluteAssetUrl(display?.avatar_url || display?.avatar_path, baseUrl);
  if (avatarUrl) {
    return `<div class="avatar avatar-image"><img src="${escapeHtml(avatarUrl)}" alt="" /></div>`;
  }
  return `<div class="avatar">${escapeHtml(initials(accountLabel))}</div>`;
}

function consentHtml(params: {
  client: IdentityClient;
  user: IdentityUser;
  scope: string;
  query: string;
  providerName: string;
  runtimePermissions?: RuntimePermission[];
  display?: ConsentDisplay;
  uiExternalUrl?: string | null;
}) {
  const scopes = scopeList(params.scope);
  const appName = params.display?.app?.name || params.client.name || params.client.client_id;
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
  const appFontLink = absoluteAssetUrl(params.display?.app?.branding_font_url, params.uiExternalUrl ?? null);
  const appBrandMarkup = appBrand(params.display?.app, appName, params.uiExternalUrl ?? null);

  return new Response(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <link rel="icon" href="data:," />
  ${appFontLink ? `<link rel="stylesheet" href="${escapeHtml(appFontLink)}" />` : ''}
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
    .app-brand {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      margin-bottom: 16px;
      min-height: 24px;
      color: #111827;
      font-size: 15px;
      font-weight: 800;
    }
    .app-icon {
      display: grid;
      place-items: center;
      width: 20px;
      height: 20px;
      color: #111827;
      font-size: 18px;
      font-weight: 800;
      overflow: hidden;
      flex: 0 0 auto;
    }
    .app-icon img { width: 20px; height: 20px; border-radius: 4px; object-fit: cover; display: block; }
    .app-icon svg { width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    .app-icon-emoji { font-size: 18px; line-height: 1; }
    .app-icon-fallback { font-size: 13px; }
    .app-name { display: inline-block; line-height: 1.2; }
    .app-name-branded { font-size: 1rem; }
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
      overflow: hidden;
    }
    .avatar img { width: 100%; height: 100%; object-fit: cover; display: block; }
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
    ${appBrandMarkup}
    <div class="intro">
      <h1>Sign in to ${escapeHtml(appName)}</h1>
    </div>
    <div class="account">
      ${accountAvatar(params.display?.user, accountLabel, params.uiExternalUrl ?? null)}
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

  const homeUrl = (await uiExternalUrl()) || '/';
  if (responseType !== 'code') {
    return { error: await renderIdentityErrorPage({ code: 'unsupported_response_type', status: 400, technical: `response_type=${responseType ?? '(none)'}`, homeUrl }) };
  }
  const client = await getClient(clientId);
  if (!client) {
    return { error: await renderIdentityErrorPage({ code: 'invalid_client', status: 400, technical: `client_id=${clientId || '(none)'}`, homeUrl }) };
  }
  if (!client.redirect_uris.includes(redirectUri)) {
    return { error: await renderIdentityErrorPage({ code: 'invalid_redirect_uri', status: 400, technical: `client ${clientId} requested ${redirectUri}`, homeUrl }) };
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
      const externalUiUrl = await uiExternalUrl();
      return consentHtml({
        client,
        user,
        scope,
        query: request.nextUrl.searchParams.toString(),
        providerName: provider.name,
        runtimePermissions: runtime?.permissions,
        display: runtime?.display,
        uiExternalUrl: externalUiUrl,
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
