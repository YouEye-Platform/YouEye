/**
 * Caddy TLS API
 * 
 * Manage TLS certificate configuration.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, verifyCSRFToken } from '@/lib/auth';
import * as caddy from '@/lib/caddy/client';

/**
 * GET /api/caddy/tls - Get TLS configuration
 */
export async function GET() {
  try {
    const session = await getSession();
    
    if (!session) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }

    const config = await caddy.getConfig();
    
    // Extract TLS info
    const tlsConfig = config.apps?.tls;
    const subjects = tlsConfig?.automation?.policies?.[0]?.subjects || [];
    const issuer = tlsConfig?.automation?.policies?.[0]?.issuers?.[0]?.module || 'unknown';

    return NextResponse.json({
      mode: issuer === 'internal' ? 'internal' : issuer === 'acme' ? 'acme' : 'manual',
      subjects,
      issuer,
    });
  } catch (error) {
    console.error('Error fetching TLS config:', error);
    return NextResponse.json(
      { 
        error: 'Failed to fetch TLS config. Is Caddy running?',
        mode: 'unknown',
        subjects: [],
      },
      { status: 503 }
    );
  }
}

/**
 * PUT /api/caddy/tls - Update TLS configuration
 */
export async function PUT(request: NextRequest) {
  try {
    const session = await getSession();
    
    if (!session) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }

    if (!session.isAdmin) {
      return NextResponse.json(
        { error: 'Admin access required' },
        { status: 403 }
      );
    }

    // Verify CSRF token
    const csrfToken = request.headers.get('X-CSRF-Token');
    if (!csrfToken || !(await verifyCSRFToken(csrfToken))) {
      return NextResponse.json(
        { error: 'Invalid CSRF token' },
        { status: 403 }
      );
    }

    const body: { hosts: string[] } = await request.json();

    if (!body.hosts || !Array.isArray(body.hosts) || body.hosts.length === 0) {
      return NextResponse.json(
        { error: 'At least one host is required' },
        { status: 400 }
      );
    }

    console.log(`[Caddy] Updating TLS for hosts: ${body.hosts.join(', ')}`);

    await caddy.updateTLS(body.hosts);

    return NextResponse.json({
      success: true,
      message: 'TLS configuration updated',
      hosts: body.hosts,
    });
  } catch (error) {
    console.error('Error updating TLS config:', error);
    return NextResponse.json(
      { 
        error: 'Failed to update TLS config',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
