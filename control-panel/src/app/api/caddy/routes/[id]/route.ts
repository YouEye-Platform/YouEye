/**
 * Caddy Route by ID API
 * 
 * Update or delete a specific route.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, verifyCSRFToken } from '@/lib/auth';
import * as caddy from '@/lib/caddy/client';
import type { RouteFormData } from '@/lib/caddy/types';

/**
 * PUT /api/caddy/routes/[id] - Update a route
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
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

    const { id } = await params;
    const body: RouteFormData = await request.json();

    console.log(`[Caddy] Updating route ${id}`);

    const route = await caddy.updateRoute(id, body);

    return NextResponse.json({
      success: true,
      route,
    });
  } catch (error) {
    console.error('Error updating route:', error);
    return NextResponse.json(
      { 
        error: 'Failed to update route',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/caddy/routes/[id] - Delete a route
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
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

    const { id } = await params;

    console.log(`[Caddy] Deleting route ${id}`);

    await caddy.removeRoute(id);

    return NextResponse.json({
      success: true,
      message: 'Route deleted',
    });
  } catch (error) {
    console.error('Error deleting route:', error);
    return NextResponse.json(
      { 
        error: 'Failed to delete route',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
