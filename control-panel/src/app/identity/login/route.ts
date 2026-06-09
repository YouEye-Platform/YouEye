import { NextRequest, NextResponse } from 'next/server';
import { getIdentityConfig } from '@/lib/identity/config';
import { verifyUser } from '@/lib/identity/store';
import { createIdentityToken } from '@/lib/identity/tokens';
import { setIdentityCookie } from '@/lib/identity/http';

function html(returnTo: string, error = ''): Response {
  const safeReturnTo = returnTo.replace(/"/g, '&quot;');
  return new Response(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <link rel="icon" href="data:," />
  <title>YouEye ID</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: Canvas; color: CanvasText; }
    main { width: min(360px, calc(100vw - 32px)); }
    h1 { font-size: 24px; margin: 0 0 6px; }
    p { margin: 0 0 22px; color: color-mix(in srgb, CanvasText 68%, transparent); }
    form { display: grid; gap: 12px; }
    label { display: grid; gap: 6px; font-size: 13px; font-weight: 600; }
    input { height: 42px; padding: 0 12px; border: 1px solid color-mix(in srgb, CanvasText 18%, transparent); border-radius: 8px; background: Canvas; color: CanvasText; font: inherit; }
    button { height: 42px; border: 0; border-radius: 8px; background: #111; color: #fff; font-weight: 700; cursor: pointer; }
    .error { min-height: 20px; color: #d12; font-size: 13px; }
  </style>
</head>
<body>
  <main>
    <h1>YouEye ID</h1>
    <p>Sign in to continue.</p>
    <form method="post">
      <input type="hidden" name="return_to" value="${safeReturnTo}" />
      <label>Username <input name="username" autocomplete="username" required autofocus /></label>
      <label>Password <input name="password" type="password" autocomplete="current-password" required /></label>
      <button type="submit">Sign In</button>
      <div class="error">${error}</div>
    </form>
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
