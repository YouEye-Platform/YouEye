/**
 * App detail API — returns full MarketApp object including detail section.
 *
 * GET /api/market/app/{appId}
 * Returns the full MarketApp object for a single app, including detail.longDescription
 * and detail.screenshots.
 */

import { NextRequest, NextResponse } from 'next/server';
import { fetchManifest, fetchAvailableApps } from '@/lib/market/catalog';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ appId: string }> }
) {
  const { appId } = await params;

  if (!appId) {
    return NextResponse.json({ error: 'Missing appId' }, { status: 400 });
  }

  try {
    // Try to find the app in the full catalog first (gives us the MarketApp shape)
    const allApps = await fetchAvailableApps();
    const app = allApps.find((a) => a.id === appId);

    if (app) {
      return NextResponse.json({ app });
    }

    // Fallback: try fetching the manifest directly
    const manifest = await fetchManifest(appId);
    return NextResponse.json({
      app: {
        id: manifest.metadata.id,
        name: manifest.metadata.name,
        description: manifest.metadata.description,
        icon: manifest.metadata.icon,
        iconUrl: manifest.metadata.iconUrl,
        category: manifest.metadata.category,
        type: manifest.type ?? 'marketplace',
        version: manifest.version,
        defaultSubdomain: manifest.metadata.defaultSubdomain,
        supportsSSO: manifest.features.supportsSSO,
        website: manifest.metadata.website,
        tags: manifest.metadata.tags,
        detail: manifest.detail
          ? {
              longDescription: manifest.detail.longDescription,
              screenshots: manifest.detail.screenshots.map((s) => ({
                url: s.path,
                caption: s.caption,
              })),
            }
          : undefined,
        installParams: manifest.native?.installParams?.map((p) => ({
          name: p.name,
          label: p.label,
          required: p.required,
          description: p.description,
        })),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    if (message.includes('not found in catalog')) {
      return NextResponse.json({ error: `App "${appId}" not found` }, { status: 404 });
    }

    return NextResponse.json(
      { error: `Failed to fetch app details: ${message}` },
      { status: 500 }
    );
  }
}
