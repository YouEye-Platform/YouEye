/**
 * Unified Market catalog API.
 * Returns all available apps (marketplace + native) from the Market GitHub repo.
 *
 * GET /api/market/catalog — all available apps
 */

import { NextResponse } from 'next/server';
import { fetchAvailableApps, fetchAvailableSystemApps, fetchCategories } from '@/lib/market/catalog';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const [apps, systemApps, categories] = await Promise.all([
      fetchAvailableApps(),
      fetchAvailableSystemApps(),
      fetchCategories(),
    ]);
    return NextResponse.json({ apps, systemApps, categories });
  } catch (err) {
    return NextResponse.json(
      { error: `Failed to fetch catalog: ${err}` },
      { status: 500 }
    );
  }
}
