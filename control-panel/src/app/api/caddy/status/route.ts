/**
 * Caddy Status API
 * 
 * Returns Caddy's running status.
 */

import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import * as caddy from '@/lib/caddy/client';

/**
 * GET /api/caddy/status - Get Caddy status
 */
export async function GET() {
  try {
    const session = await getSession();
    
    if (!session?.isAdmin) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });

    const status = await caddy.getStatus();
    return NextResponse.json(status);
  } catch (error) {
    console.error('Error fetching Caddy status:', error);
    return NextResponse.json({
      running: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
