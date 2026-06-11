import { NextRequest, NextResponse } from 'next/server';
import { getIdentityConfig } from '@/lib/identity/config';
import { getClient, verifyUser } from '@/lib/identity/store';
import { createIdentityToken } from '@/lib/identity/tokens';
import { setIdentityCookie } from '@/lib/identity/http';
import { getIdentityProviderConfig } from '@/lib/identity/provider';
import { settingsService } from '@/lib/settings';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeCss(value: unknown, fallback = ''): string {
  return typeof value === 'string' && !/[;{}<>]/.test(value) ? value : fallback;
}

async function wordmarkStyle(): Promise<string> {
  const raw = await settingsService.getRaw();
  const style = raw.site_name_style && typeof raw.site_name_style === 'object'
    ? raw.site_name_style as Record<string, unknown>
    : {};
  const gradient = style.gradient && typeof style.gradient === 'object'
    ? style.gradient as Record<string, unknown>
    : null;
  const gradientCss = gradient?.from && gradient?.to
    ? `background: linear-gradient(135deg, ${safeCss(gradient.from)}, ${safeCss(gradient.to)}); -webkit-background-clip: text; background-clip: text; color: transparent;`
    : `color: ${safeCss(style.color, '#15171a')};`;
  return [
    `font-family: "${safeCss(style.fontFamily, 'Inter')}", system-ui, sans-serif`,
    `font-size: clamp(2rem, 7vw, 3.25rem)`,
    `font-weight: ${Number(style.fontWeight) || 800}`,
    `letter-spacing: ${safeCss(style.letterSpacing, '0')}`,
    `text-transform: ${safeCss(style.textTransform, 'none')}`,
    style.textShadow && style.textShadow !== 'none' ? `text-shadow: ${safeCss(style.textShadow)}` : '',
    gradientCss,
  ].filter(Boolean).join('; ');
}

function titleCase(value: string): string {
  return value
    .split(/[\s._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}

function appNameFromClientId(clientId: string): string | null {
  const appId = clientId
    .replace(/^youeye-app-/, '')
    .replace(/^ye-/, '')
    .trim();
  return appId && appId !== clientId ? titleCase(appId) : null;
}

function appNameFromHost(hostname: string): string | null {
  const labels = hostname.split('.').filter(Boolean);
  if (labels.length < 3) return null;
  const subdomain = labels[0];
  if (['auth', 'control', 'dns', 'id', 'www'].includes(subdomain)) return null;
  return titleCase(subdomain);
}

async function resolveLoginContext(returnTo: string): Promise<string | null> {
  try {
    const url = new URL(returnTo);
    const isAuthorize = url.pathname === '/application/o/authorize' || url.pathname === '/oauth/authorize';
    if (isAuthorize) {
      const clientId = url.searchParams.get('client_id') || '';
      if (clientId) {
        const client = await getClient(clientId).catch(() => null);
        const name = client?.name?.trim() || appNameFromClientId(clientId);
        return name || null;
      }
    }
    return appNameFromHost(url.hostname);
  } catch {
    return null;
  }
}

async function html(returnTo: string, error = ''): Promise<Response> {
  const provider = await getIdentityProviderConfig();
  const wordmark = await wordmarkStyle();
  const appName = await resolveLoginContext(returnTo);
  const contextTitle = appName ? `Continue to ${appName}` : `Continue with ${provider.name}`;
  const contextDescription = appName
    ? `Sign in with ${provider.name} to keep going.`
    : `Sign in with your ${provider.name} account.`;
  return new Response(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <link rel="icon" href="data:," />
  <title>${escapeHtml(provider.name)}</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 24px;
      background: linear-gradient(145deg, #f8fbff 0%, #eef9f6 48%, #f7fbff 100%);
      color: #17191c;
    }
    main { width: min(408px, 100%); }
    .identity { margin: 0 0 18px; text-align: center; }
    .wordmark { ${wordmark}; line-height: 1; overflow-wrap: anywhere; }
    .panel {
      display: grid;
      gap: 18px;
      border: 1px solid rgba(24, 36, 48, .12);
      border-radius: 8px;
      background: rgba(255, 255, 255, .92);
      box-shadow: 0 24px 60px rgba(28, 52, 70, .12);
      padding: 26px;
    }
    .copy { display: grid; gap: 6px; text-align: center; }
    h1 { font-size: 1.35rem; line-height: 1.2; margin: 0; letter-spacing: 0; }
    p { margin: 0; color: #64717f; line-height: 1.45; }
    form { display: grid; gap: 14px; }
    label { display: grid; gap: 7px; font-size: 13px; font-weight: 700; color: #2c3440; }
    input {
      height: 44px;
      padding: 0 12px;
      border: 1px solid #cdd8e2;
      border-radius: 8px;
      background: #fff;
      color: #17191c;
      font: inherit;
      outline: none;
      transition: border-color .16s ease, box-shadow .16s ease;
    }
    input:focus { border-color: #1788ff; box-shadow: 0 0 0 3px rgba(23, 136, 255, .14); }
    button {
      height: 44px;
      border: 0;
      border-radius: 8px;
      background: #0b84ff;
      color: #fff;
      font: inherit;
      font-weight: 800;
      cursor: pointer;
      transition: background .16s ease, transform .16s ease, opacity .16s ease;
    }
    button:hover { background: #0574e5; }
    button:active { transform: translateY(1px); }
    button[disabled] { cursor: wait; opacity: .82; }
    .error {
      min-height: 18px;
      color: #b42318;
      font-size: 13px;
      line-height: 1.35;
      text-align: center;
    }
    .help { border-top: 1px solid #e6edf3; padding-top: 14px; text-align: center; font-size: 12px; color: #748292; }
    .help a { color: #216db8; text-decoration: none; font-weight: 700; }
    .help a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <main>
    <header class="identity">
      <div class="wordmark">${escapeHtml(provider.name)}</div>
    </header>
    <section class="panel">
      <div class="copy">
        <h1>${escapeHtml(contextTitle)}</h1>
        <p>${escapeHtml(contextDescription)}</p>
      </div>
      <form method="post" id="login-form">
        <input type="hidden" name="return_to" value="${escapeHtml(returnTo)}" />
        <label for="username">Username
          <input id="username" name="username" autocomplete="username" required autofocus />
        </label>
        <label for="password">Password
          <input id="password" name="password" type="password" autocomplete="current-password" required />
        </label>
        <button type="submit" id="continue-button" data-loading-text="Continuing...">Continue</button>
        <div class="error">${escapeHtml(error)}</div>
        <div class="help">Need help? Ask the person who runs this server.</div>
      </form>
    </section>
  </main>
  <script>
    const form = document.getElementById('login-form');
    const button = document.getElementById('continue-button');
    form?.addEventListener('submit', () => {
      if (!button) return;
      button.textContent = button.dataset.loadingText || 'Continuing...';
      button.setAttribute('disabled', 'true');
    });
  </script>
</body>
</html>`, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

function safeReturnTo(value: string | null, fallback: string): string {
  if (!value) return fallback;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : fallback;
  } catch {
    return fallback;
  }
}

export async function GET(request: NextRequest) {
  const config = await getIdentityConfig();
  const returnTo = safeReturnTo(request.nextUrl.searchParams.get('return_to'), `${config.externalUrl}/`);
  return html(returnTo);
}

export async function POST(request: NextRequest) {
  const config = await getIdentityConfig();
  const form = await request.formData();
  const returnTo = safeReturnTo(String(form.get('return_to') || ''), `${config.externalUrl}/`);
  const username = String(form.get('username') || '');
  const password = String(form.get('password') || '');
  const user = await verifyUser(username, password);

  if (!user) {
    return html(returnTo, 'Invalid username or password.');
  }

  const token = await createIdentityToken(user);
  const response = NextResponse.redirect(returnTo, { status: 303 });
  setIdentityCookie(response, token, config.cookieDomain);
  return response;
}
