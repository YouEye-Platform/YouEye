/**
 * Next.js Proxy (formerly Middleware) for server-side authentication.
 *
 * Verifies the session JWT, or the CLI token, before any non-public page or API route runs. Runs on the Node.js
 * runtime (Next 16's default for proxy.ts), so it can read the CLI token file itself.
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { jwtVerify } from 'jose';
import { isValidCLIToken } from '@/lib/auth/cli-token';
import { getAuthModeForHost, isLocalSetupHost, isPasswordSignInHost } from '@/lib/auth/mode';
import { isSettingsPath } from '@/lib/settings-public-path';
import { isPasswordSignInPath, requestIsPlainHttp, setupHostAllows } from '@/lib/auth/setup-host-paths';

// Public routes that don't require authentication
const PUBLIC_ROUTES = [
  '/login',
  '/settings/login',
  '/api/auth/login',
  '/api/auth/logout',
  '/api/auth/csrf',
  '/api/auth/callback',
  '/api/auth/popup-close',  // SSO popup close page
  '/api/auth/mode',
  '/api/appliance/claim',
  '/api/appliance/handoff',
  '/api/setup/config',
  '/api/setup/ca-cert',
  '/api/setup/ca-fingerprint',
  '/api/setup/server-address',
  '/api/setup/check-dns',
  '/api/setup/profile',
  '/api/deploy/infrastructure',
  '/api/deploy/infrastructure/reconcile',
  '/api/host-ip/migrate',
  '/api/ping',
  '/api/market/image',
  '/api/mail/send',       // SMTP proxy — auth via X-App-Slug / X-UI-Bridge-Token
  '/api/branding/favicon', // Public favicon (proxied from UI)
  '/identity/login',
  '/identity/handoff',
  '/identity/session/check',
  '/application/o',
  '/oauth',
  '/forward-auth/caddy',
  '/.well-known/openid-configuration',
  '/settings/api/branding/favicon',
  '/market/api/branding/favicon',
  '/api/telemetry',        // Telemetry record + export (internal tracking)
  '/setup-complete',
  '/settings/api/auth/login',
  '/settings/api/auth/logout',
  '/settings/api/auth/csrf',
  '/settings/api/auth/callback',
  '/settings/api/auth/mode',
  // Owner password reset with the code the box's console shows (no session).
  '/reset-owner',
  '/settings/reset-owner',
  '/api/auth/reset-owner',
  '/settings/api/auth/reset-owner',
  // Note: /embed routes now use session auth (same as main CP), not HMAC tokens
];

// Exact-match public routes (no prefix matching)
const PUBLIC_ROUTES_EXACT = [
  '/api/auth/sso',
  '/settings/api/auth/sso',
];

const IDENTITY_SERVICE_ROUTES = [
  '/',
  '/identity/login',
  '/identity/handoff',
  '/identity/session/check',
  '/application/o',
  '/oauth',
  '/forward-auth/caddy',
  '/.well-known/openid-configuration',
  '/api/branding/favicon',
];

const SETUP_SESSION_ROUTES = [
  '/setup',
  '/setup-complete',
  '/api/setup',
  '/api/appliance',
  '/api/auth/csrf',
  '/api/auth/logout',
  '/api/ping',
  '/api/tls',
  '/api/dns-providers/cloudflare/validate',
  '/api/branding/favicon',
];

function setupSessionAllows(pathname: string): boolean {
  return SETUP_SESSION_ROUTES.some(route => pathname === route || pathname.startsWith(route + '/'));
}

// Static resources that should be skipped
const STATIC_PATTERNS = [
  '/_next/',
  '/favicon.ico',
  '/icons/',
  '/manifest.json',
  '/manifest.webmanifest',
  '/sw.js',
  '/offline.html',
  '/swe-worker-',
  '/fonts/',
  '/mytitle/fonts/',
  '/onboarding-fonts/',
];

/**
 * The JWT secret for verifying sessions, or null when it isn't configured (the proxy then fails closed).
 */
function getProxyJWTSecret(): Uint8Array | null {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    console.error('[Proxy] JWT_SECRET not properly configured');
    return null;
  }
  return new TextEncoder().encode(secret);
}

function loginRedirectFor(request: NextRequest, pathname: string): URL {
  const host = request.headers.get('host') || '';
  const settingsPath = isSettingsPath(pathname) || pathname === '/onboarding';

  if (getAuthModeForHost(host) === 'sso') {
    const url = new URL(settingsPath ? '/settings/api/auth/sso' : '/api/auth/sso', request.url);
    const returnTo = `${request.nextUrl.pathname}${request.nextUrl.search}`;
    url.searchParams.set('redirect', returnTo);
    return url;
  }

  return new URL(settingsPath ? '/settings/login' : '/login', request.url);
}

/** Cache for setup_completed status (avoid hitting Spine on every request) */
let setupCompletedCache: { value: boolean; ts: number } | null = null;
const SETUP_CACHE_TTL = 10_000; // 10 seconds

async function isSetupCompleted(): Promise<boolean> {
  const now = Date.now();
  if (setupCompletedCache && now - setupCompletedCache.ts < SETUP_CACHE_TTL) {
    return setupCompletedCache.value;
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const controller = new AbortController();
    timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`http://127.0.0.1:3000/api/setup/config`, {
      signal: controller.signal,
    });
    if (res.ok) {
      const config = await res.json();
      const completed = !!config.setup_completed;
      setupCompletedCache = { value: completed, ts: now };
      return completed;
    }
    console.warn(`[Proxy] setup completion check returned HTTP ${res.status}; treating setup as incomplete`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[Proxy] setup completion check failed; treating setup as incomplete: ${message}`);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  // Every setup-host request asks; retry a failed read after 2 s, not on each request.
  const fallback = setupCompletedCache?.value ?? false;
  setupCompletedCache = { value: fallback, ts: now - SETUP_CACHE_TTL + 2_000 };
  return fallback;
}

/**
 * Derive the UI origin from CONTROL_EXTERNAL_URL at runtime.
 * e.g. "https://control.skibidi.io" → "https://skibidi.io"
 */
function getParentOrigin(): string {
  const controlUrl = process.env.CONTROL_EXTERNAL_URL || '';
  return controlUrl.replace('://control.', '://') || 'https://localhost';
}

function originFromUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

function rootOriginFromKnownSubdomain(origin: string, subdomains: string[]): string | null {
  try {
    const url = new URL(origin);
    const labels = url.hostname.split('.').filter(Boolean);
    if (labels.length < 3 || !subdomains.includes(labels[0])) return null;
    url.hostname = labels.slice(1).join('.');
    url.port = '';
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

function hostnameFromHostHeader(host: string): string | null {
  const firstHost = host.split(',')[0]?.trim();
  if (!firstHost) return null;
  try {
    return new URL(`https://${firstHost}`).hostname;
  } catch {
    return firstHost.split(':')[0] || null;
  }
}

function rootOriginFromIdentityHost(host: string | null, protocol: string | null): string | null {
  if (!host) return null;
  const hostname = hostnameFromHostHeader(host);
  if (!hostname || hostname === 'localhost' || hostname === '127.0.0.1' || /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) {
    return null;
  }
  const labels = hostname.split('.').filter(Boolean);
  if (labels.length < 3 || !['id', 'auth'].includes(labels[0])) return null;
  const scheme = protocol === 'http' || protocol === 'https' ? protocol : 'https';
  return `${scheme}://${labels.slice(1).join('.')}`;
}

function getUiAssetOrigin(request?: NextRequest): string | null {
  const uiOrigin = originFromUrl(process.env.UI_EXTERNAL_URL);
  if (uiOrigin) return uiOrigin;

  const generalOrigin = originFromUrl(process.env.BASE_URL) || originFromUrl(process.env.NEXTAUTH_URL);
  if (generalOrigin) {
    return rootOriginFromKnownSubdomain(generalOrigin, ['control', 'id', 'auth']) || generalOrigin;
  }

  const controlOrigin = originFromUrl(process.env.CONTROL_EXTERNAL_URL);
  if (controlOrigin) {
    return rootOriginFromKnownSubdomain(controlOrigin, ['control']) || controlOrigin;
  }

  const identityOrigin = originFromUrl(process.env.IDENTITY_URL);
  if (identityOrigin) {
    const rootOrigin = rootOriginFromKnownSubdomain(identityOrigin, ['id', 'auth']);
    if (rootOrigin) return rootOrigin;
  }

  if (!request) return null;
  const forwardedProto = request.headers.get('x-forwarded-proto') || request.nextUrl.protocol.replace(/:$/, '');
  return rootOriginFromIdentityHost(
    request.headers.get('x-forwarded-host') || request.headers.get('host') || request.nextUrl.host,
    forwardedProto.split(',')[0]?.trim() || null
  );
}

function imageSourcesForCsp(request?: NextRequest): string {
  const sources = ["'self'", 'data:'];
  const uiAssetOrigin = getUiAssetOrigin(request);
  if (uiAssetOrigin) sources.push(uiAssetOrigin);
  sources.push('https://github.com', 'https://raw.githubusercontent.com');
  return sources.join(' ');
}

/**
 * Apply CSP headers based on route — must be in middleware because
 * next.config.ts headers() is evaluated at build time, not runtime.
 */
function applySecurityHeaders(response: NextResponse, pathname: string, request?: NextRequest): NextResponse {
  if (pathname === '/api/ping') {
    response.headers.set('Content-Security-Policy',
      "default-src 'none'; script-src 'unsafe-inline'; frame-ancestors *");
  } else if (pathname.startsWith('/embed') || pathname === '/api/auth/sso' || pathname.startsWith('/api/auth/callback')) {
    // Embed pages AND the SSO auth chain need iframe-friendly CSP.
    // When an embed has no session, EmbedAuthError auto-redirects the iframe
    // through /api/auth/sso -> identity provider -> /api/auth/callback -> back to embed.
    // Without iframe-friendly headers on these paths, the browser blocks the
    // SSO redirect chain and the embed spinner hangs forever.
    const parentOrigin = getParentOrigin();
    response.headers.set('Content-Security-Policy',
      `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src ${imageSourcesForCsp(request)}; font-src 'self' data:; connect-src 'self'; frame-ancestors ${parentOrigin};`);
  } else if (pathname === '/setup-complete') {
    response.headers.set('X-Frame-Options', 'DENY');
    response.headers.set('Content-Security-Policy',
      `default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src ${imageSourcesForCsp(request)}; font-src 'self' data:; connect-src 'self'; frame-src https:; form-action 'self' https:; frame-ancestors 'none';`);
  } else {
    response.headers.set('X-Frame-Options', 'DENY');
    response.headers.set('Content-Security-Policy',
      `default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src ${imageSourcesForCsp(request)}; font-src 'self' data:; connect-src 'self'; frame-src https:; frame-ancestors 'none';`);
  }
  return response;
}

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** True when a write comes from this request's own origin (scheme from Caddy's X-Forwarded-Proto, host as sent). */
function sameOriginWrite(request: NextRequest): boolean {
  const origin = request.headers.get('origin');
  if (origin === null) {
    const site = request.headers.get('sec-fetch-site');
    return site === null || site === 'same-origin' || site === 'none';
  }
  const host = request.headers.get('host');
  if (!host) return false;
  const protocol = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim()
    || request.nextUrl.protocol.replace(':', '');
  return origin === `${protocol}://${host}`;
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (pathname === '/application/o/authorize' || pathname === '/identity/login'
    || /^\/application\/o\/[^/]+\/end-session$/.test(pathname)) {
    const { ORIGINAL_IDENTITY_QUERY_HEADER, originalIdentityQuery } = await import('./lib/identity/authorize-query');
    const headers = new Headers(request.headers);
    headers.set(ORIGINAL_IDENTITY_QUERY_HEADER, originalIdentityQuery(request));
    return applySecurityHeaders(NextResponse.next({ request: { headers } }), pathname, request);
  }

  // Skip static resources before identity-service route narrowing so the
  // white-label login can load its local WordArt font CSS/assets.
  if (STATIC_PATTERNS.some(pattern => pathname.startsWith(pattern))) {
    return NextResponse.next();
  }

  if (process.env.IDENTITY_SERVICE === 'true') {
    const allowed = IDENTITY_SERVICE_ROUTES.some(route => pathname === route || pathname.startsWith(route + '/'));
    if (!allowed) {
      return new NextResponse('Not Found', { status: 404 });
    }
    return applySecurityHeaders(NextResponse.next(), pathname, request);
  }

  if (pathname === '/identity/session/check') {
    return applySecurityHeaders(NextResponse.next(), pathname, request);
  }

  // Track route usage for beta telemetry (fire-and-forget, no latency impact)
  if (!pathname.startsWith('/api/telemetry/')) {
    void fetch(`http://localhost:3000/api/telemetry/record`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ route: pathname }),
    }).catch(() => {});
  }

  const host = request.headers.get('host') || '';
  const sessionCookie = request.cookies.get('ye-session');
  let verifiedSession: Record<string, unknown> | null = null;
  if (sessionCookie?.value) {
    const secret = getProxyJWTSecret();
    if (secret) {
      try {
        verifiedSession = (await jwtVerify(sessionCookie.value, secret)).payload;
      } catch {
        verifiedSession = null;
      }
    }
  }

  // --- Local setup surface (box IP or youeye.local through Caddy, HTTP or HTTPS) ---
  // Setup routing must win before the Control Panel shell redirects. Onboarding only
  // (`setup-host-paths.ts`): claim and setup until setup completes, then just the
  // DNS/trust hand-off page and the owner reset; never the Settings surface.
  if (isLocalSetupHost(host)) {
    // A password never crosses the LAN in cleartext.
    if (isPasswordSignInPath(pathname) && requestIsPlainHttp(request.headers.get('x-forwarded-proto'), request.url)) {
      return NextResponse.json({ error: 'Password sign-in needs HTTPS.' }, { status: 403 });
    }

    const completed = await isSetupCompleted();
    if (!setupHostAllows(pathname, request.method, completed)) {
      if (pathname.startsWith('/api/')) {
        return NextResponse.json({ error: 'Not available on the setup address.' }, { status: 404 });
      }
      return NextResponse.redirect(new URL(completed ? '/setup-complete' : '/login', request.url));
    }

    // For /setup-complete, if setup is NOT completed, redirect to login.
    if (pathname === '/setup-complete' && !completed) {
      return NextResponse.redirect(new URL('/login', request.url));
    }

    if (pathname === '/setup' && verifiedSession?.authMethod !== 'setup') {
      return NextResponse.redirect(new URL('/login', request.url));
    }
  }

  if (verifiedSession?.authMethod === 'setup' && !setupSessionAllows(pathname)) {
    return pathname.startsWith('/api/')
      ? NextResponse.json({ error: 'The setup session is restricted to appliance onboarding.' }, { status: 403 })
      : NextResponse.redirect(new URL('/setup', request.url));
  }

  // --- Send the control.<domain> / (dashboard) shell paths to Settings (D4) ---
  // Settings is the only admin surface. Redirect the shell paths to it: subdomain (control.<base>) → base-domain Settings;
  // direct/PAM access (IP or :3000) → same-origin /settings. This never matches
  // /settings, /market, /embed, /api, or identity routes (different prefixes),
  // so the Settings surface, embeds, and APIs keep working on either host.
  {
    const shellHost = host.split(':')[0];
    const SHELL_PREFIXES = ['/apps', '/dns', '/health', '/people', '/proxy', '/updates'];
    const isShellRoute =
      pathname === '/' || SHELL_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + '/'));
    if (isShellRoute) {
      return shellHost.startsWith('control.')
        ? NextResponse.redirect(`${getParentOrigin()}/settings`)
        : NextResponse.redirect(new URL('/settings', request.url));
    }
  }

  // Allow public routes
  if (
    PUBLIC_ROUTES.some(route => pathname === route || pathname.startsWith(route + '/')) ||
    PUBLIC_ROUTES_EXACT.some(route => pathname === route)
  ) {
    // Password sign-in only on the local setup surface and loopback; named hosts use SSO
    if (isPasswordSignInPath(pathname)) {
      if (!isPasswordSignInHost(request.headers.get('host') || '')) {
        return NextResponse.json(
          { error: 'PAM login is not available on subdomain access. Use SSO.' },
          { status: 403 }
        );
      }
    }
    return applySecurityHeaders(NextResponse.next(), pathname, request);
  }

  // Embed routes handle their own auth (show sign-in prompt within iframe).
  // Don't redirect to /login — that would get blocked by frame-ancestors.
  if (pathname.startsWith('/embed')) {
    return applySecurityHeaders(NextResponse.next(), pathname, request);
  }

  // CLI token authentication: an /api request that carries X-CLI-Token passes only with the valid token. The header
  // alone never opens a route (it did before 0.6.8, which left routes without their own check open to the LAN).
  const cliToken = request.headers.get('x-cli-token');
  if (cliToken !== null && pathname.startsWith('/api/')) {
    if (isValidCLIToken(cliToken)) return applySecurityHeaders(NextResponse.next(), pathname, request);
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Cookie-authenticated writes must come from this origin. The session cookie is SameSite=None on HTTPS names (the
  // dashboard embeds Control Panel pages), so without this any site an admin visits could post to admin routes that
  // don't check a CSRF token. Browsers always send Origin on cross-origin writes; a request without Origin (curl,
  // Spine) carries no victim cookie.
  if (UNSAFE_METHODS.has(request.method) && !sameOriginWrite(request)) {
    return NextResponse.json({ error: 'Cross-site request refused' }, { status: 403 });
  }

  // Get session cookie
  if (!sessionCookie?.value) {
    // No session - redirect to login for pages, return 401 for API
    if (pathname.startsWith('/api/')) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }
    return NextResponse.redirect(loginRedirectFor(request, pathname));
  }

  // Verify JWT
  const secret = getProxyJWTSecret();
  if (!secret) {
    // Fail closed: without the secret no session can be verified.
    console.error('[Proxy] Cannot verify JWT - JWT_SECRET not configured');
    return pathname.startsWith('/api/')
      ? NextResponse.json({ error: 'Sign-in is unavailable' }, { status: 503 })
      : new NextResponse('Sign-in is unavailable', { status: 503 });
  }

  try {
    if (!verifiedSession) await jwtVerify(sessionCookie.value, secret);
    return applySecurityHeaders(NextResponse.next(), pathname, request);
  } catch (error) {
    console.log('[Proxy] Invalid JWT token, redirecting to login');

    const response = pathname.startsWith('/api/')
      ? NextResponse.json({ error: 'Session expired' }, { status: 401 })
      : NextResponse.redirect(loginRedirectFor(request, pathname));

    response.cookies.delete('ye-session');
    response.cookies.delete('ye-csrf');

    return response;
  }
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - public folder
     */
    '/((?!_next/static|_next/image|favicon.ico|icons|manifest.json|manifest.webmanifest|sw.js|swe-worker-).*)',
  ],
};
