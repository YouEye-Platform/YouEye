/**
 * Container Route API
 * 
 * Sets up routing for a specific container with subdomain or path routing.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, verifyCSRFToken } from '@/lib/auth';
import { setContainerRoute, getConfiguredDomain, checkHealth, type RouteType } from '@/lib/caddy/client';

/**
 * POST /api/containers/[name]/route - Set routing for a container
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!session.isAdmin) {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
    }

    // Verify CSRF token
    const csrfToken = request.headers.get('X-CSRF-Token');
    if (!csrfToken || !(await verifyCSRFToken(csrfToken))) {
      return NextResponse.json({ error: 'Invalid CSRF token' }, { status: 403 });
    }

    const { name: containerName } = await params;
    const body = await request.json();
    const { routeType, routeValue, port } = body as {
      routeType: RouteType;
      routeValue: string;
      port: number;
    };

    // Validate inputs
    if (!routeType || !['subdomain', 'path', 'none'].includes(routeType)) {
      return NextResponse.json(
        { error: 'Invalid route type. Must be subdomain, path, or none.' },
        { status: 400 }
      );
    }

    if (routeType !== 'none' && (!routeValue || typeof routeValue !== 'string')) {
      return NextResponse.json(
        { error: 'Route value is required for subdomain and path routes.' },
        { status: 400 }
      );
    }

    if (!port || typeof port !== 'number' || port < 1 || port > 65535) {
      return NextResponse.json(
        { error: 'Valid port number is required.' },
        { status: 400 }
      );
    }

    // Check if Caddy is running
    const healthy = await checkHealth();
    if (!healthy) {
      return NextResponse.json(
        { error: 'Caddy is not running. Install and start Caddy first.' },
        { status: 503 }
      );
    }

    // Get configured domain
    const domain = await getConfiguredDomain();
    if (!domain) {
      return NextResponse.json(
        { error: 'No domain configured. Set a domain first.' },
        { status: 400 }
      );
    }

    console.log(`[Route] Setting ${routeType} route for ${containerName}: ${routeValue || 'none'} by ${session.username}`);

    const result = await setContainerRoute(
      domain,
      containerName,
      port,
      routeType,
      routeValue || ''
    );

    if (!result.success) {
      return NextResponse.json(
        { error: result.error || 'Failed to set route' },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      message: routeType === 'none' 
        ? `Route removed for ${containerName}`
        : `Route set: ${routeType === 'subdomain' ? `${routeValue}.${domain}` : `${domain}${routeValue}`} -> ${containerName}:${port}`,
      warning: result.warning,
    });
  } catch (error) {
    console.error('Error setting container route:', error);
    return NextResponse.json(
      { 
        error: 'Failed to set container route',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
