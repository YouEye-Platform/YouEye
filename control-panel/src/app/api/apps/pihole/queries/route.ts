/**
 * Pi-Hole Query Log API
 *
 * Get recent DNS queries from Pi-Hole FTL v6
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { getQueryLog } from '@/lib/apps/pihole-api';

export async function GET(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const limit = parseInt(request.nextUrl.searchParams.get('limit') || '100');
    const safeLimit = Math.min(Math.max(limit, 10), 500);

    const queries = await getQueryLog(safeLimit);

    return NextResponse.json({
      queries: queries.map((q) => ({
        timestamp: q.timestamp,
        type: q.type,
        domain: q.domain,
        client: q.client,
        status: 0, // Status code not available in same format
        reply: q.status,
        replyTime: q.replyTime,
      })),
      total: queries.length,
    });
  } catch (error) {
    console.error('Error getting query log:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to get query log' },
      { status: 500 }
    );
  }
}
