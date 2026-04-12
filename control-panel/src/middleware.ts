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
  '/api/auth/mode',
  '/api/setup/config',
  '/api/setup/ca-cert',
  '/api/deploy/infrastructure',
  '/api/ui-bridge',
  '/api/deploy/infrastructure/reconcile',
  '/api/host-ip/migrate',
  '/api/ping',
  '/api/market/image',
  '/api/mail/send',       // SMTP proxy — auth via X-App-Slug / X-UI-Bridge-Token
  '/api/connectors',
  '/setup-complete',
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
      '/api/auth/', '/api/setup/', '/api/deploy/',
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
    return NextResponse.next();
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
    // JWT_SECRET not configured - this is a server configuration error
    // Allow the request through, the page will handle it
    console.error('[Middleware] Cannot verify JWT - JWT_SECRET not configured');
    return NextResponse.next();
  }

  try {
    await jwtVerify(sessionCookie.value, secret);
    // Token is valid, allow request
    return NextResponse.next();
  } catch (error) {
    // Token is invalid or expired
    console.log('[Middleware] Invalid JWT token, redirecting to login');
    
    // Clear invalid cookies
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
    '/((?!_next/static|_next/image|favicon.ico|icons|manifest.json).*)',
  ],
};
