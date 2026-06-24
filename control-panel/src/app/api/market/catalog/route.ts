/**
 * Unified Market catalog API.
 * Returns all available apps (marketplace + native) from the Market GitHub repo.
 *
 * GET /api/market/catalog — all available apps
 */

import { NextResponse } from 'next/server';
import { fetchAvailableApps, fetchAvailableSystemApps, fetchBundles, fetchCategories, fetchCuration } from '@/lib/market/catalog';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const [apps, systemApps, categories, curation, bundles] = await Promise.all([
      fetchAvailableApps(),
      fetchAvailableSystemApps(),
      fetchCategories(),
      fetchCuration(),
      fetchBundles(),
    ]);
    return NextResponse.json({ apps, systemApps, categories, curation, bundles });
  } catch (err) {
    return NextResponse.json(
      { error: `Failed to fetch catalog: ${err}` },
      { status: 500 }
    );
  }
}
