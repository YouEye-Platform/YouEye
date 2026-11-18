/**
 * Unified Market catalog API.
 *
 * GET /api/market/catalog — every app of the box's enabled markets (container and native apps) and the apps added
 * by URL, with categories, curation, bundles and `warnings`. It reads the box's copy of each market
 * (lib/market/market-store.ts) and waits for a market only when that copy is still empty or right after an explicit
 * "check for updates". An app this box cannot install carries `installBlocked` (and `needsYouEye`).
 */

import { NextResponse } from 'next/server';
import { fetchAvailableApps, fetchBundles, fetchCategories, fetchCuration } from '@/lib/market/catalog';
import { listDirectMarketAppViews } from '@/lib/market/direct-apps';
import type { CatalogWarning } from '@/lib/market/partial-catalog';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const warnings: CatalogWarning[] = [];
    const [catalogApps, directApps, categories, curation, bundles] = await Promise.all([
      fetchAvailableApps((warning) => warnings.push(warning)),
      listDirectMarketAppViews(),
      fetchCategories(),
      fetchCuration(),
      fetchBundles(),
    ]);
    return NextResponse.json({ apps: [...directApps, ...catalogApps], categories, curation, bundles, warnings });
  } catch (err) {
    return NextResponse.json(
      { error: `Failed to fetch catalog: ${err}` },
      { status: 500 }
    );
  }
}
