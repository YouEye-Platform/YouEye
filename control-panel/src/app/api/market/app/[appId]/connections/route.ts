/**
 * Connections API — returns connection requirements for an app.
 *
 * GET /api/market/app/{appId}/connections
 * Returns outgoing wants (this app → others), incoming wants (others → this app),
 * and internet access requirements. Used by the install dialog to show
 * connection toggles.
 */

import { NextRequest, NextResponse } from 'next/server';
import { fetchManifest, fetchAvailableApps } from '@/lib/market/catalog';
import { getAllInstalledApps } from '@/lib/market/installed-apps';

export const dynamic = 'force-dynamic';

export interface ConnectionInfo {
  targetAppId: string;
  targetAppName: string;
  description?: string;
  installed: boolean;
  defaultPort?: number;
}

export interface ConnectionsResponse {
  outgoing: ConnectionInfo[];
  incoming: ConnectionInfo[];
  internet: { hosts: string[]; needsInternet: boolean };
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ appId: string }> }
) {
  const { appId } = await params;

  if (!appId) {
    return NextResponse.json({ error: 'Missing appId' }, { status: 400 });
  }

  try {
    const manifest = await fetchManifest(appId);
    const installedApps = await getAllInstalledApps().catch(() => []);
    const installedIds = new Set(installedApps.map(a => a.appId));

    // Outgoing: this app's wants (appId-based only — type-based resolved via /api/market/providers)
    const outgoing: ConnectionInfo[] = (manifest.wants ?? [])
      .filter(w => !!w.appId)
      .map(w => ({
        targetAppId: w.appId!,
        targetAppName: w.name,
        description: w.description,
        installed: installedIds.has(w.appId!),
        defaultPort: w.defaultPort,
      }));

    // Incoming: other apps whose wants include this app (by appId or by matching provides.type)
    const incoming: ConnectionInfo[] = [];
    const thisProvides = manifest.provides ?? [];
    const thisProvideTypes = new Set(thisProvides.map(p => p.type));
    try {
      const allApps = await fetchAvailableApps();
      for (const app of allApps) {
        if (app.id === appId) continue;
        try {
          const otherManifest = await fetchManifest(app.id);
          const wantsThis = (otherManifest.wants ?? []).find(
            w => w.appId === appId || (w.type && thisProvideTypes.has(w.type))
          );
          if (wantsThis) {
            incoming.push({
              targetAppId: app.id,
              targetAppName: app.name,
              description: wantsThis.description,
              installed: installedIds.has(app.id),
            });
          }
        } catch {
          // Skip apps whose manifests can't be fetched
        }
      }
    } catch {
      // Skip incoming check if catalog fetch fails
    }

    // Internet access requirements
    const internet = {
      hosts: manifest.internet?.hosts ?? [],
      needsInternet: (manifest.internet?.hosts?.length ?? 0) > 0
        || manifest.containers.some(c => c.network === 'internet'),
    };

    return NextResponse.json({ outgoing, incoming, internet } satisfies ConnectionsResponse);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('not found in catalog')) {
      return NextResponse.json({ error: `App "${appId}" not found` }, { status: 404 });
    }
    return NextResponse.json(
      { error: `Failed to fetch connections: ${message}` },
      { status: 500 }
    );
  }
}
