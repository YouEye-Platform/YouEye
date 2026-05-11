/**
 * Next.js Middleware for Server-Side Authentication
 * 
 * Verifies JWT tokens before rendering protected pages.
 * This runs at the edge, before the page is rendered.
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { jwtVerify } from 'jose';

// Public routes that don't require authentication
const PUBLIC_ROUTES = [
  '/login',
  '/api/auth/login',
  '/api/auth/logout',
  '/api/auth/csrf',
  '/api/auth/callback',
  '/api/auth/popup-close',  // SSO popup close page
  '/api/auth/mode',
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
  '/setup-complete',
  // Note: /embed routes now use session auth (same as main CP), not HMAC tokens
];

// Exact-match public routes (no prefix matching)
const PUBLIC_ROUTES_EXACT = [
  '/api/auth/sso',
];

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

/**
 * Check if request is coming via IP address through Caddy (not port 3000).
 * Port 3000 = direct CP access (bypass setup flow).
 * Ports 80/443 via Caddy with IP host = setup flow.
 */
function isIPViaCaddy(host: string): boolean {
  const [hostname, portStr] = host.split(':');
  const port = portStr ? parseInt(portStr, 10) : 443;

  // Port 3000 = direct access, not through Caddy
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
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`http://localhost:3000/api/setup/config`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (res.ok) {
      const config = await res.json();
      const completed = !!config.setup_completed;
      setupCompletedCache = { value: completed, ts: now };
      return completed;
    }
  } catch {
    // If we can't check, assume not completed to allow setup
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

/**
 * Apply CSP headers based on route — must be in middleware because
 * next.config.ts headers() is evaluated at build time, not runtime.
 */
function applySecurityHeaders(response: NextResponse, pathname: string): NextResponse {
  if (pathname === '/api/ping') {
    response.headers.set('Content-Security-Policy',
      "default-src 'none'; script-src 'unsafe-inline'; frame-ancestors *");
  } else if (pathname.startsWith('/embed') || pathname === '/api/auth/sso' || pathname.startsWith('/api/auth/callback')) {
    // Embed pages AND the SSO auth chain need iframe-friendly CSP.
    // When an embed has no session, EmbedAuthError auto-redirects the iframe
    // through /api/auth/sso → Authentik → /api/auth/callback → back to embed.
    // Without iframe-friendly headers on these paths, the browser blocks the
    // SSO redirect chain and the embed spinner hangs forever.
    const parentOrigin = getParentOrigin();
    response.headers.set('Content-Security-Policy',
      `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://git.byka.wtf; font-src 'self' data:; connect-src 'self'; frame-ancestors ${parentOrigin};`);
  } else {
    response.headers.set('X-Frame-Options', 'DENY');
    response.headers.set('Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://git.byka.wtf; font-src 'self' data:; connect-src 'self'; frame-src https:; frame-ancestors 'none';");
  }
  return response;
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Skip static resources
  if (STATIC_PATTERNS.some(pattern => pathname.startsWith(pattern))) {
    return NextResponse.next();
  }

  // --- IP-via-Caddy setup flow ---
  // When accessed via IP through Caddy (ports 80/443), redirect to setup flow
  const host = request.headers.get('host') || '';
  if (isIPViaCaddy(host)) {
    // Allow these paths through (needed for setup flow to work)
    const setupAllowedPaths = [
      '/setup', '/setup-complete', '/login',
      '/api/auth/', '/api/setup/', '/api/deploy/', '/api/tls/',
    ];
    const isSetupPath = setupAllowedPaths.some(p => pathname === p || pathname.startsWith(p));

    if (!isSetupPath) {
      // Redirect based on setup state
      const completed = await isSetupCompleted();
      if (completed) {
        // After setup, IP access shows the DNS explainer page so users learn
        // how to configure DNS and access YouEye via its domain name.
        // Direct CP access on :3000 still works for admin use.
        return NextResponse.redirect(new URL('/setup-complete', request.url));
      } else {
        return NextResponse.redirect(new URL('/login', request.url));
      }
    }

    // For /setup-complete, if setup is NOT completed, redirect to login  
    if (pathname === '/setup-complete') {
      const completed = await isSetupCompleted();
      if (!completed) {
        return NextResponse.redirect(new URL('/login', request.url));
      }
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
    return applySecurityHeaders(NextResponse.next(), pathname);
  }

  // Embed routes handle their own auth (show sign-in prompt within iframe).
  // Don't redirect to /login — that would get blocked by frame-ancestors.
  if (pathname.startsWith('/embed')) {
    return applySecurityHeaders(NextResponse.next(), pathname);
  }

  // Get session cookie
  const sessionCookie = request.cookies.get('ye-session');

  if (!sessionCookie?.value) {
    // No session - redirect to login for pages, return 401 for API
    if (pathname.startsWith('/api/')) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }
    return NextResponse.redirect(new URL('/login', request.url));
  }

  // Verify JWT
  const secret = getMiddlewareJWTSecret();
  if (!secret) {
    console.error('[Middleware] Cannot verify JWT - JWT_SECRET not configured');
    return applySecurityHeaders(NextResponse.next(), pathname);
  }

  try {
    await jwtVerify(sessionCookie.value, secret);
    return applySecurityHeaders(NextResponse.next(), pathname);
  } catch (error) {
    console.log('[Middleware] Invalid JWT token, redirecting to login');

    const response = pathname.startsWith('/api/')
      ? NextResponse.json({ error: 'Session expired' }, { status: 401 })
      : NextResponse.redirect(new URL('/login', request.url));

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
