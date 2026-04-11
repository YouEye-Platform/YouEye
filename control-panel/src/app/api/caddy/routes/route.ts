/**
 * Caddy Routes API
 * 
 * Manages proxy routes in Caddy.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, verifyCSRFToken } from '@/lib/auth';
import * as caddy from '@/lib/caddy/client';
import type { RouteFormData } from '@/lib/caddy/types';

/**
 * GET /api/caddy/routes - List all proxy routes
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

    const routes = await caddy.getRoutes();
    return NextResponse.json({ routes });
  } catch (error) {
    // Caddy might not be running
    console.error('Error fetching Caddy routes:', error);
    return NextResponse.json(
      { 
        error: 'Failed to fetch routes. Is Caddy running?',
        routes: [],
      },
      { status: 503 }
    );
  }
}

/**
 * POST /api/caddy/routes - Add a new route
 */
export async function POST(request: NextRequest) {
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

    const body: RouteFormData = await request.json();

    // Validate required fields
    if (!body.upstream || !body.port) {
      return NextResponse.json(
        { error: 'Upstream and port are required' },
        { status: 400 }
      );
    }

    // Set default path if not provided
    if (!body.path) {
      body.path = '/*';
    }

    console.log(`[Caddy] Adding route: ${body.hostname || '*'}${body.path} -> ${body.upstream}:${body.port}`);

    const route = await caddy.addRoute(body);

    return NextResponse.json({
      success: true,
      route,
    });
  } catch (error) {
    console.error('Error adding route:', error);
    return NextResponse.json(
      { 
        error: 'Failed to add route',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
