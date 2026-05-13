/**
 * Provider Options API — returns an app's type-based wants with available providers.
 *
 * GET /api/market/app/{appId}/provider-options
 *
 * Used by the Network tab embed to render the provider selection UI.
 * For each type-based want, returns installed providers and current connection status.
 */

import { NextResponse } from 'next/server';
import { fetchManifest } from '@/lib/market/catalog';
import { listInstalledApps, readInstallMetadata } from '@/lib/market/metadata';
import { getBridgesForApp } from '@/lib/bridges/manager';

export const dynamic = 'force-dynamic';

interface ProviderOption {
  appId: string;
  name: string;
  description?: string;
  port?: number;
  installed: boolean;
}

interface TypeWant {
  type: string;
  name: string;
  description?: string;
  defaultPort?: number;
  providers: ProviderOption[];
  /** Currently connected provider appId (via active bridge), or null */
  connectedProvider: string | null;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ appId: string }> },
) {
  const { appId } = await params;

  try {
    // 1. Get the app's manifest to read its wants
    let wants: Array<{ appId?: string; type?: string; name: string; description?: string; defaultPort?: number }> = [];
    try {
      const manifest = await fetchManifest(appId);
      wants = manifest.wants ?? [];
    } catch {
      // App may not have a manifest in catalog (e.g. custom install)
      return NextResponse.json({ typeWants: [] });
    }

    // 2. Filter to type-based wants only (appId-based are handled by the bridge system)
    const typeWants = wants.filter(w => w.type && !w.appId);
    if (typeWants.length === 0) {
      return NextResponse.json({ typeWants: [] });
    }

    // 3. Get all installed apps with their provides info
    const allMeta = await listInstalledApps();

    // 4. Get active bridges for this app
    const bridges = await getBridgesForApp(appId);
    const activeBridges = bridges.filter(b => b.active && b.from === appId);

    // 5. Build response for each type-based want
    const result: TypeWant[] = [];

    for (const want of typeWants) {
      const providers: ProviderOption[] = [];

      for (const meta of allMeta) {
        // Skip the requesting app itself
        if (meta.appId === appId) continue;

        // Check install metadata for provides
        let matched = false;
        if (meta.provides?.length) {
          const match = meta.provides.find(p => p.type === want.type);
          if (match) {
            providers.push({
              appId: meta.appId,
              name: meta.appId,
              description: match.description,
              port: match.port,
              installed: true,
            });
            matched = true;
          }
        }

        // Fallback: check manifest from catalog
        if (!matched) {
          try {
            const m = await fetchManifest(meta.appId);
            const match = m.provides?.find((p: any) => p.type === want.type);
            if (match) {
              providers.push({
                appId: meta.appId,
                name: m.metadata.name,
                description: match.description,
                port: match.port,
                installed: true,
              });
            }
          } catch {
            // Skip
          }
        }
      }

      // Enrich names from manifests
      for (const p of providers) {
        if (p.name === p.appId) {
          try {
            const m = await fetchManifest(p.appId);
            p.name = m.metadata.name;
          } catch {
            // Keep appId as name
          }
        }
      }

      // Find if any provider is currently connected via an active bridge
      const connectedBridge = activeBridges.find(b =>
        providers.some(p => p.appId === b.to)
      );

      result.push({
        type: want.type!,
        name: want.name,
        description: want.description,
        defaultPort: want.defaultPort,
        providers,
        connectedProvider: connectedBridge?.to ?? null,
      });
    }

    return NextResponse.json({ typeWants: result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `Failed to get provider options: ${message}` },
      { status: 500 },
    );
  }
}
