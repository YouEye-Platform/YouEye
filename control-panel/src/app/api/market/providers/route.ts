/**
 * Providers API — find installed apps that provide a given capability type.
 *
 * GET /api/market/providers?type=search-engine
 *
 * Scans install metadata for apps whose `provides` array contains a matching type.
 * Falls back to fetching the manifest from the catalog for apps installed before
 * the `provides` field was added to install metadata.
 */

import { NextRequest, NextResponse } from 'next/server';
import { listInstalledApps, readInstallMetadata } from '@/lib/market/metadata';
import { fetchManifest } from '@/lib/market/catalog';

export const dynamic = 'force-dynamic';

export interface ProviderInfo {
  appId: string;
  name: string;
  type: string;
  description?: string;
  port?: number;
  installed: true;
}

export async function GET(request: NextRequest) {
  const type = request.nextUrl.searchParams.get('type');

  try {
    const allMeta = await listInstalledApps();
    const providers: ProviderInfo[] = [];

    for (const meta of allMeta) {
      // Check install metadata first (fast path)
      if (meta.provides?.length) {
        for (const p of meta.provides) {
          if (!type || p.type === type) {
            providers.push({
              appId: meta.appId,
              name: meta.appId, // Will be enriched below
              type: p.type,
              description: p.description,
              port: p.port,
              installed: true,
            });
          }
        }
        continue;
      }

      // Fallback: check manifest from catalog (for apps installed before provides support)
      try {
        const manifest = await fetchManifest(meta.appId);
        const manifestProvides = manifest.provides ?? [];
        for (const p of manifestProvides) {
          if (!type || p.type === type) {
            providers.push({
              appId: meta.appId,
              name: manifest.metadata.name,
              type: p.type,
              description: p.description,
              port: p.port,
              installed: true,
            });
          }
        }
      } catch {
        // Skip apps whose manifests can't be fetched
      }
    }

    // Enrich names from manifests for install-metadata-sourced entries
    for (const p of providers) {
      if (p.name === p.appId) {
        try {
          const manifest = await fetchManifest(p.appId);
          p.name = manifest.metadata.name;
        } catch {
          // Keep appId as name
        }
      }
    }

    return NextResponse.json({ providers });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `Failed to query providers: ${message}` },
      { status: 500 },
    );
  }
}
