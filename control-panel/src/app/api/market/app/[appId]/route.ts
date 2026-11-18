/**
 * App detail API.
 *
 * GET /api/market/app/{appId}[?source=<source id>]
 *
 * - `app`: the full MarketApp of the app in the named source (the first enabled market that has it when none is
 *   named), detail included. An app this box cannot install carries `installBlocked` (and `needsYouEye`).
 * - `variants`: every other enabled market, and every app added by URL, that also has this app id (`MarketAppVariant`).
 * - `installed`: for an installed app, where it takes its updates from as its install recorded it (source id, name,
 *   market address, version, `updateBlocked`), kept apart from `app`, which may be another market's variant. Null
 *   when the app is not installed.
 */

import { NextRequest, NextResponse } from 'next/server';
import { fetchManifestFromSource, fetchAvailableApps } from '@/lib/market/catalog';
import { directMarketAppToMarketApp, getDirectMarketApp, listDirectMarketAppViews } from '@/lib/market/direct-apps';
import { getInstalledApp } from '@/lib/market/installed-apps';
import { marketSourceView } from '@/lib/market/market-store';
import { readInstallMetadata } from '@/lib/market/metadata';
import { getConfiguredMarketSources, OFFICIAL_MARKET_NAME, OFFICIAL_MARKET_SOURCE_ID } from '@/lib/market/source';
import { recordedCatalogSourceIds } from '@/lib/market/update-routing';
import type { MarketApp, MarketAppInstalledSource, MarketAppVariant } from '@/lib/market/types';

export const dynamic = 'force-dynamic';

function variantOf(app: MarketApp): MarketAppVariant | null {
  if (!app.sourceId) return null;
  return {
    sourceId: app.sourceId,
    sourceName: app.sourceName || app.sourceId,
    version: app.version ?? null,
    ...(app.sourceNotAccepted ? { sourceNotAccepted: true as const } : {}),
    ...(app.installBlocked ? { installBlocked: true as const } : {}),
    ...(app.needsYouEye ? { needsYouEye: app.needsYouEye } : {}),
  };
}

/** Where an installed app takes its updates from, as recorded; null when it is not installed. */
async function installedSource(appId: string): Promise<MarketAppInstalledSource | null> {
  const [metadata, record] = await Promise.all([
    readInstallMetadata(appId).catch(() => null),
    getInstalledApp(appId).catch(() => null),
  ]);
  if (!metadata && !record) return null;
  const sourceId = recordedCatalogSourceIds(record ?? {}, metadata ?? {})[0] ?? null;
  let sourceName = metadata?.sourceName || record?.sourceName || null;
  let sourceAddress = metadata?.sourceRepoUrl || record?.sourceRepoUrl || null;
  if (sourceId === OFFICIAL_MARKET_SOURCE_ID) {
    // The official Market's address follows the box's channel: the one its copy was last read from.
    const official = (await getConfiguredMarketSources()).find((source) => source.id === OFFICIAL_MARKET_SOURCE_ID);
    sourceName = OFFICIAL_MARKET_NAME;
    sourceAddress = official ? (await marketSourceView(official).catch(() => null))?.address ?? null : null;
  } else if (sourceId?.startsWith('direct:')) {
    sourceName = 'Added';
    sourceAddress = sourceAddress || (await getDirectMarketApp(sourceId).catch(() => null))?.manifestUrl || null;
  }
  return {
    sourceId,
    sourceName: sourceName || sourceId,
    sourceAddress,
    version: record?.installedVersion || metadata?.installedVersion || null,
    updateBlocked: record?.updateBlocked ?? null,
  };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ appId: string }> }
) {
  const { appId } = await params;
  const sourceId = request.nextUrl.searchParams.get('source') || undefined;

  if (!appId) {
    return NextResponse.json({ error: 'Missing appId' }, { status: 400 });
  }

  try {
    // The app in every enabled market and among the apps added by URL.
    const [allApps, directApps] = await Promise.all([
      fetchAvailableApps(),
      listDirectMarketAppViews().catch(() => [] as MarketApp[]),
    ]);
    // After the listing: the official Market's address is the one its copy was just read from.
    const installed = await installedSource(appId);
    const candidates = [...allApps, ...directApps].filter((candidate) => candidate.id === appId);

    let app: MarketApp | undefined;
    if (sourceId?.startsWith('direct:')) {
      const direct = await getDirectMarketApp(sourceId, appId);
      if (!direct) return NextResponse.json({ error: `App "${appId}" not found` }, { status: 404 });
      app = directMarketAppToMarketApp(direct);
    } else {
      app = candidates.find((candidate) => !candidate.sourceId?.startsWith('direct:') && (!sourceId || candidate.sourceId === sourceId))
        // Only added by URL: that app.
        ?? (sourceId ? undefined : candidates[0]);
    }
    const variants = candidates
      .filter((candidate) => candidate.sourceId && candidate.sourceId !== app?.sourceId)
      .map(variantOf)
      .filter((variant): variant is MarketAppVariant => variant !== null);

    if (app) {
      return NextResponse.json({ app, variants, installed });
    }

    // Not listed (its market could not be read just now): the manifest from the named source, with the real reason
    // when that fails too.
    const manifest = await fetchManifestFromSource(appId, sourceId);
    return NextResponse.json({
      app: {
        id: manifest.metadata.id,
        name: manifest.metadata.name,
        description: manifest.metadata.description,
        icon: manifest.metadata.icon,
        iconUrl: manifest.metadata.iconUrl,
        category: manifest.metadata.category,
        integration: manifest.integration,
        version: manifest.version,
        defaultSubdomain: manifest.metadata.defaultSubdomain,
        supportsSSO: !!manifest.sso,
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
        setups: manifest.setups.map((setup) => ({ name: setup.name, for: setup.for })),
        forwardAuth: manifest.forwardAuth,
      },
      variants,
      installed,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    if (/not found in (catalog|Market source)|Market source "[^"]*" not found/.test(message)) {
      return NextResponse.json({ error: `App "${appId}" not found` }, { status: 404 });
    }

    return NextResponse.json(
      { error: `Failed to fetch app details: ${message}` },
      { status: 500 }
    );
  }
}
