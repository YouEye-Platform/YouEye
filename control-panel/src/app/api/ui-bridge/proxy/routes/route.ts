/**
 * UI Bridge: Proxy Routes
 *
 * GET /api/ui-bridge/proxy/routes
 *
 * Returns Caddy reverse proxy routes in a simplified format.
 * Reuses the existing Caddy client library.
 */

import { NextRequest, NextResponse } from 'next/server';
import { validateBridgeToken } from '@/lib/ui-bridge/auth';
import { getRoutes } from '@/lib/caddy/client';

export async function GET(request: NextRequest) {
  const authError = await validateBridgeToken(request);
  if (authError) return authError;

  try {
    const proxyRoutes = await getRoutes();

    const routes = proxyRoutes.map((route) => ({
      id: route.id,
      match_domain: route.hostname || '*',
      upstream: `${route.upstream}:${route.port}`,
      tls_enabled: true, // Caddy uses HTTPS by default in our setup
    }));

    return NextResponse.json({ routes });
  } catch (err) {
    console.error('[UI Bridge] Proxy routes error:', err);
    return NextResponse.json(
      { error: 'Failed to retrieve proxy routes', routes: [] },
      { status: 503 }
    );
  }
}
