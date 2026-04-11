/**
 * UI Bridge: Market
 *
 * GET  ?action=catalog          — full catalog with install status
 * GET  ?action=status           — install status of all/specific app
 * GET  ?action=updates          — apps with available updates
 * GET  ?action=installed-versions — installed app versions
 * GET  ?action=install-progress — active install progress (events, done)
 * POST ?action=install          — start install (SSE stream)
 * POST ?action=uninstall        — remove app
 * POST ?action=refresh-catalog  — refresh catalog and check for updates
 *
 * Note: Since Next.js dynamic routes don't support sub-paths in catch-all
 * without additional nesting, we use query params to distinguish operations.
 */

import { NextRequest, NextResponse } from 'next/server';
import { validateBridgeToken } from '@/lib/ui-bridge/auth';
import { fetchAvailableApps, fetchManifest, clearCatalogCache } from '@/lib/market/catalog';
import { installApp } from '@/lib/market/engine';
import { installNativeApp } from '@/lib/native-apps/installer';
import { uninstallApp } from '@/lib/market/uninstaller';
import { listInstalledApps, readInstallMetadata } from '@/lib/market/metadata';
import { getAllInstalledApps, getAppsWithUpdatesAvailable } from '@/lib/market/installed-apps';
import { refreshVersionCheck, getLastVersionCheckAt, getLastVersionCheckResults } from '@/lib/market/version-checker';
import { getAllActiveInstalls, getTrackedInstall, cancelInstall } from '@/lib/market/install-tracker';
import type { InstallConfig, InstallEvent } from '@/lib/market/types';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const authError = await validateBridgeToken(request);
  if (authError) return authError;

  const action = request.nextUrl.searchParams.get('action') || 'catalog';

  try {
    if (action === 'image') {
      // Proxy image requests through the market image endpoint
      const imageUrl = request.nextUrl.searchParams.get('url');
      if (!imageUrl) {
        return NextResponse.json({ error: 'url parameter required' }, { status: 400 });
      }
      const proxyUrl = `http://localhost:3000/api/market/image?url=${encodeURIComponent(imageUrl)}`;
      const imgRes = await fetch(proxyUrl);
      const contentType = imgRes.headers.get('content-type') || 'application/octet-stream';
      const buf = await imgRes.arrayBuffer();
      return new NextResponse(buf, {
        status: imgRes.status,
        headers: {
          'Content-Type': contentType,
          'Cache-Control': 'public, max-age=86400',
        },
      });
    }

    if (action === 'status') {
      const appId = request.nextUrl.searchParams.get('app');
      if (appId) {
        const metadata = await readInstallMetadata(appId);
        return NextResponse.json(metadata || { appId, status: 'not-installed' });
      }
      const installed = await listInstalledApps();
      return NextResponse.json({ apps: installed });
    }

    if (action === 'updates') {
      const appsWithUpdates = getLastVersionCheckResults();
      const lastChecked = getLastVersionCheckAt();
      return NextResponse.json({
        updates: appsWithUpdates,
        lastCheckedAt: lastChecked,
        count: appsWithUpdates.length,
      });
    }

    if (action === 'installed-versions') {
      const installed = await getAllInstalledApps();
      return NextResponse.json({ apps: installed });
    }

    if (action === 'install-progress') {
      const appId = request.nextUrl.searchParams.get('app');
      if (appId) {
        const install = getTrackedInstall(appId);
        if (!install) {
          return NextResponse.json({ error: 'No tracked install found' }, { status: 404 });
        }
        return NextResponse.json(install);
      }
      const installs = getAllActiveInstalls();
      return NextResponse.json({ installs });
    }

    // Default: catalog
    const apps = await fetchAvailableApps();
    // Merge with install status and version info
    const installed = await listInstalledApps();
    const installedMap = new Map(installed.map((m) => [m.appId, m]));
    let dbApps: Awaited<ReturnType<typeof getAllInstalledApps>> = [];
    try {
      dbApps = await getAllInstalledApps();
    } catch {
      dbApps = [];
    }
    const dbMap = new Map(dbApps.map((a) => [a.appId, a]));

    const catalog = apps.map((app) => {
      const dbInfo = dbMap.get(app.id);
      return {
        ...app,
        installed: installedMap.has(app.id),
        installInfo: installedMap.get(app.id) || null,
        installedVersion: dbInfo?.installedVersion || null,
        updateAvailable: dbInfo?.updateAvailable || false,
        catalogVersion: dbInfo?.catalogVersion || app.version || null,
      };
    });

    return NextResponse.json({ apps: catalog });
  } catch (err) {
    console.error('[UI Bridge] Market GET error:', err);
    return NextResponse.json(
      { error: String(err) },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  const authError = await validateBridgeToken(request);
  if (authError) return authError;

  const action = request.nextUrl.searchParams.get('action') || 'install';

  if (action === 'refresh-catalog') {
    try {
      clearCatalogCache();
      const appsWithUpdates = await refreshVersionCheck();
      return NextResponse.json({
        success: true,
        updates: appsWithUpdates,
        count: appsWithUpdates.length,
      });
    } catch (err) {
      return NextResponse.json(
        { error: `Catalog refresh failed: ${err}` },
        { status: 500 }
      );
    }
  }

  if (action === 'cancel-install') {
    try {
      const body = await request.json();
      if (!body.appId) {
        return NextResponse.json({ error: 'Missing appId' }, { status: 400 });
      }
      const cancelled = cancelInstall(body.appId);
      if (!cancelled) {
        return NextResponse.json({ error: 'No active install found for this app' }, { status: 404 });
      }
      return NextResponse.json({ success: true, message: `Install of ${body.appId} cancelled` });
    } catch (err) {
      return NextResponse.json({ error: String(err) }, { status: 500 });
    }
  }

  if (action === 'uninstall') {
    try {
      const body = await request.json();
      if (!body.appId) {
        return NextResponse.json({ error: 'Missing appId' }, { status: 400 });
      }

      let dropSharedDatabase = false;
      try {
        const manifest = await fetchManifest(body.appId);
        dropSharedDatabase = manifest.uninstall?.dropSharedDatabase ?? false;
      } catch {
        // proceed without dropping shared DB
      }

      const result = await uninstallApp(body.appId, { dropSharedDatabase });
      return NextResponse.json(result);
    } catch (err) {
      return NextResponse.json(
        { success: false, errors: [String(err)] },
        { status: 500 }
      );
    }
  }

  // Default: install SSE — SSO is auto-enabled, no enableSSO flag needed
  let config: InstallConfig;
  try {
    config = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!config.appId || !config.subdomain || !config.domain) {
    return new Response(
      JSON.stringify({ error: 'Missing required fields: appId, subdomain, domain' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  let manifest;
  try {
    manifest = await fetchManifest(config.appId);
  } catch (err) {
    return new Response(
      JSON.stringify({ error: `Failed to fetch manifest: ${err}` }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const { startTracking: startTrack, trackEvent: trackEv, finishTracking: finishTrack } = await import('@/lib/market/install-tracker');
  const abortController = startTrack(config.appId, manifest.metadata?.name || config.appId);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const onEvent = (event: InstallEvent) => {
        trackEv(config.appId, event);
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {}
      };

      try {
        if (manifest.type === 'native') {
          // Native app: use LXD deployer
          const nativeAppId = config.appId.startsWith('ye-')
            ? config.appId
            : `ye-${config.appId}`;
          await installNativeApp(
            {
              appId: nativeAppId,
              subdomain: config.subdomain,
              domain: config.domain,
              installParams: config.installParams,
            },
            onEvent
          );
        } else {
          // Marketplace app: use OCI engine
          await installApp(manifest, config, onEvent, abortController.signal);
        }
        finishTrack(config.appId);
      } catch (err) {
        finishTrack(config.appId, String(err));
        try {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                step: 0,
                totalSteps: 0,
                status: 'error',
                message: 'Installation failed',
                detail: String(err),
              })}\n\n`
            )
          );
        } catch {}
      } finally {
        try { controller.close(); } catch {}
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
