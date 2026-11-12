/**
 * Unified Market catalog API.
 * Returns all available apps (Market-installed + native) from the Market GitHub repo.
 *
 * GET /api/market/catalog — all available apps
 */

import { NextResponse } from 'next/server';
import { fetchAvailableApps, fetchAvailableSystemApps, fetchBundles, fetchCategories, fetchCuration } from '@/lib/market/catalog';
import { listDirectMarketAppViews } from '@/lib/market/direct-apps';
import type { CatalogWarning } from '@/lib/market/partial-catalog';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const warnings: CatalogWarning[] = [];
    const [catalogApps, directApps, systemApps, categories, curation, bundles] = await Promise.all([
      fetchAvailableApps((warning) => warnings.push(warning)),
      listDirectMarketAppViews(),
      fetchAvailableSystemApps(),
      fetchCategories(),
      fetchCuration(),
      fetchBundles(),
    ]);
    return NextResponse.json({ apps: [...directApps, ...catalogApps], systemApps, categories, curation, bundles, warnings });
  } catch (err) {
    return NextResponse.json(
      { error: `Failed to fetch catalog: ${err}` },
      { status: 500 }
    );
  }
}
