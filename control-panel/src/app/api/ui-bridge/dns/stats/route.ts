/**
 * UI Bridge: DNS Stats
 *
 * GET /api/ui-bridge/dns/stats
 *
 * Returns Pi-Hole DNS statistics.
 * Reuses the existing pihole-api library.
 */

import { NextRequest, NextResponse } from 'next/server';
import { validateBridgeToken } from '@/lib/ui-bridge/auth';
import { getStats, getQueryLog } from '@/lib/apps/pihole-api';

export async function GET(request: NextRequest) {
  const authError = await validateBridgeToken(request);
  if (authError) return authError;

  try {
    const stats = await getStats();

    // Get recent queries to derive top queries and top blocked
    let topQueries: Array<{ domain: string; count: number }> = [];
    let topBlocked: Array<{ domain: string; count: number }> = [];
    let gravitySize = stats.domainsBlocked;

    try {
      const queries = await getQueryLog(1000);

      // Count domains
      const queryCounts = new Map<string, number>();
      const blockedCounts = new Map<string, number>();

      for (const q of queries) {
        queryCounts.set(q.domain, (queryCounts.get(q.domain) || 0) + 1);
        if (q.status.toLowerCase().includes('blocked') || q.status.toLowerCase().includes('gravity')) {
          blockedCounts.set(q.domain, (blockedCounts.get(q.domain) || 0) + 1);
        }
      }

      topQueries = Array.from(queryCounts.entries())
        .map(([domain, count]) => ({ domain, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);

      topBlocked = Array.from(blockedCounts.entries())
        .map(([domain, count]) => ({ domain, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);
    } catch {
      // Query log may not be available — return empty lists
    }

    return NextResponse.json({
      status: stats.status,
      queries_today: stats.queriesToday,
      blocked_today: stats.adsBlockedToday,
      percent_blocked: stats.adsPercentage,
      top_queries: topQueries,
      top_blocked: topBlocked,
      gravity_size: gravitySize,
    });
  } catch (err) {
    console.error('[UI Bridge] DNS stats error:', err);
    return NextResponse.json(
      { error: 'Failed to retrieve DNS statistics' },
      { status: 500 }
    );
  }
}
