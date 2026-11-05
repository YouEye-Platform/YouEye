/**
 * Caddy Config API
 * 
 * Get or set Caddy's full configuration.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, verifyCSRFToken } from '@/lib/auth';
import * as caddy from '@/lib/caddy/client';
import type { CaddyConfig } from '@/lib/caddy/types';

/**
 * GET /api/caddy/config - Get full Caddy config
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
    return NextResponse.json({ config });
  } catch (error) {
    console.error('Error fetching Caddy config:', error);
    return NextResponse.json(
      { 
        error: 'Failed to fetch config. Is Caddy running?',
        config: null,
      },
      { status: 503 }
    );
  }
}

/**
 * PUT /api/caddy/config - Set full Caddy config
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

    const body: { config: CaddyConfig } = await request.json();

    if (!body.config) {
      return NextResponse.json(
        { error: 'Config is required' },
        { status: 400 }
      );
    }

    console.log('[Caddy] Setting full config');

    await caddy.setConfig(body.config);

    return NextResponse.json({
      success: true,
      message: 'Config updated',
    });
  } catch (error) {
    console.error('Error setting Caddy config:', error);
    return NextResponse.json(
      { 
        error: 'Failed to set config',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
