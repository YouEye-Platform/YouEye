/**
 * Unauthenticated health-check endpoint for Spine.
 *
 * BUG-017: Spine's post-update health check hit /api/health which requires
 * admin auth, causing 401 and false "update failed" reports. This endpoint
 * bypasses auth middleware (listed in PUBLIC_ROUTES) so Spine can verify
 * the Control Panel is running without needing a session.
 *
 * ?verify=1 — returns a tiny HTML page that sends postMessage to the parent
 * frame.  Used by the setup-complete page's iframe-based connectivity check
 * to detect whether the user's device can actually reach the configured
 * domain (DNS + cert).  Caddy's path-only /api/ping route forwards ALL
 * hosts to CP, so https://devvm.test/api/ping?verify=1 hits this handler
 * even though devvm.test normally routes to YE-UI.
 */

import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  if (request.nextUrl.searchParams.get('verify') === '1') {
    // Override the global CSP (frame-ancestors 'none') so this page can
    // be embedded in the setup-complete iframe connectivity check.
    return new Response(
      '<!DOCTYPE html><html><body><script>try{window.parent.postMessage({type:"ye-dns-ok"},"*")}catch(e){}</script></body></html>',
      {
        status: 200,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; frame-ancestors *",
          'X-Frame-Options': 'ALLOWALL',
        },
      },
    );
  }

  return NextResponse.json({ status: 'ok' }, { status: 200 });
}
