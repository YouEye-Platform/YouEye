/**
 * PostgreSQL Stats API
 *
 * GET /api/apps/postgres/stats
 * Returns database server stats.
 */

import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { getStats } from '@/lib/postgres/client';

export async function GET() {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const stats = await getStats();
    return NextResponse.json(stats);
  } catch (error) {
    console.error('Error getting PostgreSQL stats:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to get PostgreSQL stats' },
      { status: 500 }
    );
  }
}
