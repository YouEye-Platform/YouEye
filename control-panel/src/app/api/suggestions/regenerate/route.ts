/**
 * Suggestions Regeneration API
 *
 * POST /api/suggestions/regenerate
 *
 * Scans all installed apps, fetches their manifests, and generates
 * connection suggestions for any that don't already have them.
 * Used to backfill suggestions for apps installed before the
 * suggestions engine existed.
 */

import { NextResponse } from 'next/server';
import { getAllInstalledApps } from '@/lib/market/installed-apps';
import { fetchManifest } from '@/lib/market/catalog';
import { generateSuggestionsForApp } from '@/lib/bridges/suggestions';

export async function POST() {
  const installed = await getAllInstalledApps();
  let totalGenerated = 0;
  const results: { appId: string; generated: number; error?: string }[] = [];

  for (const app of installed) {
    try {
      const manifest = await fetchManifest(app.appId);
      const suggestions = await generateSuggestionsForApp(manifest);
      results.push({ appId: app.appId, generated: suggestions.length });
      totalGenerated += suggestions.length;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ appId: app.appId, generated: 0, error: msg });
    }
  }

  return NextResponse.json({
    total: totalGenerated,
    apps: results,
  });
}
