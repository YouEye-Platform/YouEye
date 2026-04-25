/**
 * Network migration + metadata fix endpoint.
 *
 * POST /api/admin/migrate-networks
 * Body: { appIds?: string[], fixMetadataOnly?: boolean }
 *
 * fixMetadataOnly=true (default now):
 *   For apps already on per-app bridges, patches install.json with
 *   usePerAppBridge=true and bridgeName, and strips stale aclName
 *   from bridge/internet-grant records.
 *
 * fixMetadataOnly=false:
 *   Full migration: creates bridge, stops containers, switches NIC,
 *   adds proxy devices, updates Caddy routes, etc.
 */

import { NextRequest, NextResponse } from 'next/server';
import { migrateAppToPerAppBridge, listAppNetworks, hasAppNetwork } from '@/lib/incus/app-network';
import { readInstallMetadata, saveInstallMetadata } from '@/lib/market/metadata';
import { getContainerIP } from '@/lib/incus/container-ip';
import { getRoutes, removeRoute, addRoute } from '@/lib/caddy/client';

export async function POST(request: NextRequest) {
  let body: { appIds?: string[]; fixMetadataOnly?: boolean } = {};
  try {
    body = await request.json();
  } catch {
    // No body = fix metadata for all
  }

  const fixMetadataOnly = body.fixMetadataOnly ?? true;

  // Find all installed apps
  const { readdirSync, existsSync, readFileSync, writeFileSync } = await import('fs');
  const appDir = '/var/lib/youeye';
  const allDirs = readdirSync(appDir).filter(d =>
    d.startsWith('app-') && existsSync(`${appDir}/${d}/install.json`)
  );

  const appIds = body.appIds || allDirs.map(d => d.replace('app-', ''));

  // Get the current bridge registry for lookups
  const appNetworks = await listAppNetworks();
  const bridgeMap = new Map(appNetworks.map(n => [n.appId, n.bridgeName]));

  const results: Array<{
    appId: string;
    status: 'fixed' | 'migrated' | 'skipped' | 'error';
    detail?: string;
  }> = [];

  for (const appId of appIds) {
    const meta = await readInstallMetadata(appId);
    if (!meta) {
      results.push({ appId, status: 'skipped', detail: 'No install metadata' });
      continue;
    }

    if (fixMetadataOnly) {
      // Check if this app actually has a per-app bridge
      const bridgeName = bridgeMap.get(appId);
      if (!bridgeName) {
        results.push({ appId, status: 'skipped', detail: 'No per-app bridge found in registry' });
        continue;
      }

      if (meta.usePerAppBridge) {
        results.push({ appId, status: 'skipped', detail: 'Metadata already correct' });
        continue;
      }

      // Patch the metadata
      const updated = { ...meta, usePerAppBridge: true, bridgeName };
      await saveInstallMetadata(updated);
      results.push({ appId, status: 'fixed', detail: `Set usePerAppBridge=true, bridgeName=${bridgeName}` });
      continue;
    }

    // Full migration path (legacy — kept for completeness)
    if (meta.usePerAppBridge) {
      results.push({ appId, status: 'skipped', detail: 'Already on per-app bridge' });
      continue;
    }

    const containerNames = meta.containers.map((c: any) =>
      typeof c === 'string' ? c : c.containerName
    );

    const needsSharedDb = (meta.databaseMode ?? 'none') === 'shared';
    const needsSSO = meta.hasSSO ?? meta.enableSSO ?? false;

    try {
      const result = await migrateAppToPerAppBridge(appId, containerNames, {
        nat: false,
        needsSharedDb,
        needsSSO,
      });

      if (!result.success) {
        results.push({ appId, status: 'error', detail: result.error });
        continue;
      }

      // Update Caddy route: switch upstream from DNS name to IP
      const primaryContainer = containerNames[0];
      const newIP = await getContainerIP(primaryContainer);
      if (newIP && meta.subdomain && meta.domain) {
        const hostname = `${meta.subdomain}.${meta.domain}`;
        const routes = await getRoutes();
        for (const route of routes) {
          if (route.hostname === hostname) {
            const port = route.port || 3000;
            await removeRoute(route.id);
            await addRoute({
              hostname,
              path: '/*',
              upstream: newIP,
              port,
            });
            break;
          }
        }
      }

      // Update metadata
      await saveInstallMetadata({ ...meta, usePerAppBridge: true });
      results.push({ appId, status: 'migrated' });
    } catch (err) {
      results.push({ appId, status: 'error', detail: String(err) });
    }
  }

  // Clean up stale aclName from bridge and internet-grant records
  let bridgesCleaned = 0;
  let grantsCleaned = 0;
  try {
    const bridgesPath = '/var/lib/youeye/bridges/bridges.json';
    if (existsSync(bridgesPath)) {
      const bridges = JSON.parse(readFileSync(bridgesPath, 'utf-8'));
      let changed = false;
      for (const bridge of bridges) {
        if (bridge.aclName) {
          delete bridge.aclName;
          changed = true;
          bridgesCleaned++;
        }
      }
      if (changed) {
        writeFileSync(bridgesPath, JSON.stringify(bridges, null, 2));
      }
    }

    const grantsPath = '/var/lib/youeye/bridges/internet-grants.json';
    if (existsSync(grantsPath)) {
      const grants = JSON.parse(readFileSync(grantsPath, 'utf-8'));
      let changed = false;
      for (const grant of grants) {
        if (grant.aclName) {
          delete grant.aclName;
          changed = true;
          grantsCleaned++;
        }
      }
      if (changed) {
        writeFileSync(grantsPath, JSON.stringify(grants, null, 2));
      }
    }
  } catch (err) {
    console.warn('[migrate-networks] Failed to clean bridge/grant records:', err);
  }

  return NextResponse.json({
    total: results.length,
    fixed: results.filter(r => r.status === 'fixed').length,
    migrated: results.filter(r => r.status === 'migrated').length,
    skipped: results.filter(r => r.status === 'skipped').length,
    errors: results.filter(r => r.status === 'error').length,
    bridgesCleaned,
    grantsCleaned,
    results,
  });
}
