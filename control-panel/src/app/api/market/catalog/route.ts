/**
 * Unified App Market catalog API.
 * Returns all available apps (marketplace + native) from the YE-AppMarket Gitea repo.
 *
 * GET /api/market/catalog — all available apps
 */

import { NextResponse } from 'next/server';
import { fetchAvailableApps } from '@/lib/market/catalog';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const apps = await fetchAvailableApps();
    return NextResponse.json({ apps });
  } catch (err) {
    return NextResponse.json(
      { error: `Failed to fetch catalog: ${err}` },
      { status: 500 }
    );
  }
}
