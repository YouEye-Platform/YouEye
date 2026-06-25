/**
 * Pi-Hole Stats API Proxy
 *
 * Proxies requests to Pi-Hole's FTL v6 API
 */

import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { getStats } from '@/lib/apps/pihole-api';

export async function GET() {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const stats = await getStats();

    return NextResponse.json({
      domainsBlocked: stats.domainsBlocked,
      queriesToday: stats.queriesToday,
      adsBlockedToday: stats.adsBlockedToday,
      adsPercentage: stats.adsPercentage,
      uniqueDomains: 0, // Not available in FTL v6 summary
      queriesForwarded: 0,
      queriesCached: 0,
      clientsSeenEver: 0,
      uniqueClients: 0,
      status: stats.status,
    });
  } catch (error) {
    console.error('Error getting Pi-Hole stats:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to get Pi-Hole stats' },
      { status: 500 }
    );
  }
}
