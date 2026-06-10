import { NextRequest, NextResponse } from 'next/server';
import { getIdentityConfig } from '@/lib/identity/config';
import { verifyUser } from '@/lib/identity/store';
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

async function html(returnTo: string, error = ''): Promise<Response> {
  const provider = await getIdentityProviderConfig();
  const wordmark = await wordmarkStyle();
  const safeReturnTo = returnTo.replace(/"/g, '&quot;');
  return new Response(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <link rel="icon" href="data:," />
  <title>${escapeHtml(provider.name)}</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: radial-gradient(circle at 20% 12%, rgba(86, 178, 255, .18), transparent 32%), linear-gradient(145deg, #f7f9fb, #eef4f1 48%, #f6f2e9); color: #15171a; }
    main { width: min(390px, calc(100vw - 32px)); }
    .wordmark { ${wordmark}; margin: 0 0 10px; line-height: 1; overflow-wrap: anywhere; }
    .panel { display: grid; gap: 14px; border: 1px solid rgba(21, 23, 26, .12); border-radius: 12px; background: rgba(255,255,255,.74); box-shadow: 0 24px 70px rgba(25, 42, 55, .13); padding: 22px; backdrop-filter: blur(16px); }
    h1 { font-size: 1.15rem; margin: 0; }
    p { margin: 0; color: rgba(21, 23, 26, .68); }
    form { display: grid; gap: 12px; }
    label { display: grid; gap: 6px; font-size: 13px; font-weight: 700; }
    input { height: 44px; padding: 0 12px; border: 1px solid rgba(21, 23, 26, .16); border-radius: 8px; background: rgba(255,255,255,.9); color: #15171a; font: inherit; }
    button { height: 44px; border: 0; border-radius: 8px; background: #15171a; color: #fff; font-weight: 800; cursor: pointer; }
    .error { min-height: 20px; color: #d12; font-size: 13px; }
  </style>
</head>
<body>
  <main>
    <div class="wordmark">${escapeHtml(provider.name)}</div>
    <section class="panel">
      <h1>Welcome back</h1>
      <p>Sign in to continue.</p>
      <form method="post">
        <input type="hidden" name="return_to" value="${safeReturnTo}" />
        <label>Username <input name="username" autocomplete="username" required autofocus /></label>
        <label>Password <input name="password" type="password" autocomplete="current-password" required /></label>
        <button type="submit">Sign in</button>
        <div class="error">${escapeHtml(error)}</div>
      </form>
    </section>
  </main>
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
