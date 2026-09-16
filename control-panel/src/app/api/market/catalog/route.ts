/**
 * Unified Market catalog API.
 * Returns all available apps (Market-installed + native) from the Market GitHub repo.
 *
 * GET /api/market/catalog — all available apps
 */

import { NextResponse } from 'next/server';
import { fetchAvailableApps, fetchAvailableSystemApps, fetchBundles, fetchCategories, fetchCuration } from '@/lib/market/catalog';
import { listDirectMarketAppViews } from '@/lib/market/direct-apps';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const [catalogApps, directApps, systemApps, categories, curation, bundles] = await Promise.all([
      fetchAvailableApps(),
      listDirectMarketAppViews(),
      fetchAvailableSystemApps(),
      fetchCategories(),
      fetchCuration(),
      fetchBundles(),
    ]);
    return NextResponse.json({ apps: [...directApps, ...catalogApps], systemApps, categories, curation, bundles });
  } catch (err) {
    return NextResponse.json(
      { error: `Failed to fetch catalog: ${err}` },
      { status: 500 }
    );
  }
}
