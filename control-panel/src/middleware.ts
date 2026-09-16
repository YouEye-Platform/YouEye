/**
 * Next.js Middleware for Server-Side Authentication
 *
 * Verifies JWT tokens before rendering protected pages.
 * This runs in Edge runtime — telemetry is tracked via a fire-and-forget
 * fetch to /api/telemetry/record (Node.js) to avoid the Edge/Node.js split.
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { jwtVerify } from 'jose';
import { getAuthModeForHost } from '@/lib/auth/mode';
import { isSettingsPath } from '@/lib/settings-public-path';

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
  '/api/setup/check-dns',
  '/api/setup/profile',
  '/api/deploy/infrastructure',
  '/api/ui-bridge',
  '/api/deploy/infrastructure/reconcile',
  '/api/host-ip/migrate',
  '/api/ping',
  '/api/market/image',
  '/api/mail/send',       // SMTP proxy — auth via X-App-Slug / X-UI-Bridge-Token
  '/api/ui',              // Embed client-side calls to UI bridge proxy (branding, etc.)
  '/api/bridges',         // Internal: UI server-side fetches bridge data
  '/api/internet-grants', // Internal: UI server-side fetches internet grant data
  '/api/suggestions',     // Internal: UI server-side fetches connection suggestions
  '/api/market/app',      // Internal: app detail + connections endpoints
  '/api/branding/favicon', // Public favicon (proxied from UI)
  '/identity/login',
  '/identity/handoff',
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
  // Note: /embed routes now use session auth (same as main CP), not HMAC tokens
];

// Exact-match public routes (no prefix matching)
const PUBLIC_ROUTES_EXACT = [
  '/api/auth/sso',
  '/settings/api/auth/sso',
];

const IDENTITY_SERVICE_ROUTES = [
  '/identity/login',
  '/identity/handoff',
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
  '/swe-worker-',
  '/fonts/',
];

/**
 * Get JWT secret for middleware verification
 * In middleware, we need to handle the case where JWT_SECRET might not be set
 */
function getMiddlewareJWTSecret(): Uint8Array | null {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    console.error('[Middleware] JWT_SECRET not properly configured');
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

/**
 * Check if request is coming via IP address through Caddy.
 * Raw port 3000 is localhost-only recovery and should not be used for LAN browsing.
 * Ports 80/443 via Caddy with IP host = setup flow.
 */
function isIPViaCaddy(host: string): boolean {
  const [hostname, portStr] = host.split(':');
  const port = portStr ? parseInt(portStr, 10) : 443;

  // Port 3000 is localhost-only recovery, not the Caddy setup/browser path.
  if (port === 3000) return false;

  // Check if hostname is an IP address
  return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
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
    console.warn(`[Middleware] setup completion check returned HTTP ${res.status}; treating setup as incomplete`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[Middleware] setup completion check failed; treating setup as incomplete: ${message}`);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  return setupCompletedCache?.value ?? false;
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

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

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
    const secret = getMiddlewareJWTSecret();
    if (secret) {
      try {
        verifiedSession = (await jwtVerify(sessionCookie.value, secret)).payload;
      } catch {
        verifiedSession = null;
      }
    }
  }

  // --- IP-via-Caddy setup flow ---
  // When accessed via IP through Caddy (ports 80/443), setup routing must win
  // before legacy Control Panel shell redirects. After setup completes, the IP
  // address is a DNS/trust handoff page, never the Settings surface.
  if (isIPViaCaddy(host)) {
    // Allow these paths through (needed for setup flow to work)
    const setupAllowedPaths = [
      '/setup', '/setup-complete', '/login',
      '/api/auth/', '/api/setup/', '/api/deploy/', '/api/tls/',
      '/api/appliance/',
      '/api/dns-providers/cloudflare/validate',
      '/api/branding/favicon',
    ];
    const isSetupPath = setupAllowedPaths.some(p => pathname === p || pathname.startsWith(p));

    if (!isSetupPath) {
      const completed = await isSetupCompleted();
      return NextResponse.redirect(new URL(completed ? '/setup-complete' : '/login', request.url));
    }

    // For /setup-complete, if setup is NOT completed, redirect to login.
    if (pathname === '/setup-complete') {
      const completed = await isSetupCompleted();
      if (!completed) {
        return NextResponse.redirect(new URL('/login', request.url));
      }
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

  // --- Retire the legacy control.<domain> / (dashboard) shell (D4) ---
  // The old admin shell is replaced by the unified Settings. Redirect its
  // routes to Settings: subdomain (control.<base>) → base-domain Settings;
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
    // Block PAM login on subdomain access when SSO is configured
    if (pathname === '/api/auth/login') {
      const host = request.headers.get('host') || '';
      const hostname = host.split(':')[0];
      const isIP = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname) ||
        hostname === 'localhost' || hostname === '127.0.0.1';
      if (!isIP) {
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

  // CLI token authentication — if X-CLI-Token header is present on API routes,
  // let the request through to the route handler where getSession() will validate
  // the token value in Node.js runtime (middleware runs in Edge where fs is unavailable).
  if (pathname.startsWith('/api/') && request.headers.get('x-cli-token')) {
    return applySecurityHeaders(NextResponse.next(), pathname, request);
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
  const secret = getMiddlewareJWTSecret();
  if (!secret) {
    console.error('[Middleware] Cannot verify JWT - JWT_SECRET not configured');
    return applySecurityHeaders(NextResponse.next(), pathname, request);
  }

  try {
    if (!verifiedSession) await jwtVerify(sessionCookie.value, secret);
    return applySecurityHeaders(NextResponse.next(), pathname, request);
  } catch (error) {
    console.log('[Middleware] Invalid JWT token, redirecting to login');

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
