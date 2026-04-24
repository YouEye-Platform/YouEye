/**
 * Migrate existing apps from incusbr0 (ACL) to per-app bridges.
 *
 * POST /api/admin/migrate-networks
 * Body: { appIds?: string[] }  — omit appIds to migrate all, or specify a subset
 *
 * For each app:
 * 1. Create per-app bridge
 * 2. Stop container(s), switch NIC, add proxy devices, start
 * 3. Add Caddy NIC
 * 4. Update Caddy route to use IP
 * 5. Update install metadata: usePerAppBridge = true
 * 6. Delete old ACLs
 */

import { NextRequest, NextResponse } from 'next/server';
import { migrateAppToPerAppBridge } from '@/lib/incus/app-network';
import { readInstallMetadata, saveInstallMetadata } from '@/lib/market/metadata';
import { getContainerIP } from '@/lib/incus/container-ip';
import { getRoutes, removeRoute, addRoute } from '@/lib/caddy/client';

export async function POST(request: NextRequest) {
  let body: { appIds?: string[] } = {};
  try {
    body = await request.json();
  } catch {
    // No body = migrate all
  }

  // Find all installed apps
  const { readdirSync, existsSync } = await import('fs');
  const appDir = '/var/lib/youeye';
  const allDirs = readdirSync(appDir).filter(d =>
    d.startsWith('app-') && existsSync(`${appDir}/${d}/install.json`)
  );

  const appIds = body.appIds || allDirs.map(d => d.replace('app-', ''));

  const results: Array<{
    appId: string;
    status: 'migrated' | 'skipped' | 'error';
    detail?: string;
  }> = [];

  for (const appId of appIds) {
    const meta = await readInstallMetadata(appId);
    if (!meta) {
      results.push({ appId, status: 'skipped', detail: 'No install metadata' });
      continue;
    }

    if (meta.usePerAppBridge) {
      results.push({ appId, status: 'skipped', detail: 'Already on per-app bridge' });
      continue;
    }

    const containerNames = meta.containers.map((c: any) =>
      typeof c === 'string' ? c : c.containerName
    );

    const needsSharedDb = (meta.databaseMode ?? 'none') === 'shared';
    const needsSSO = meta.hasSSO ?? meta.enableSSO ?? false;
    const wantsInternet = false; // Existing apps had internet via ACL grants — we can re-enable later

    try {
      const result = await migrateAppToPerAppBridge(appId, containerNames, {
        nat: wantsInternet,
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
            // Remove old route and add new one with IP
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

      // Delete old ACLs
      try {
        const { deleteContainerAcl } = await import('@/lib/incus/network-acl');
        for (const cn of containerNames) {
          await deleteContainerAcl(cn);
        }
      } catch {
        // ACL cleanup is best-effort
      }

      // Update metadata
      await saveInstallMetadata({ ...meta, usePerAppBridge: true });

      results.push({ appId, status: 'migrated' });
    } catch (err) {
      results.push({ appId, status: 'error', detail: String(err) });
    }
  }

  return NextResponse.json({
    total: results.length,
    migrated: results.filter(r => r.status === 'migrated').length,
    skipped: results.filter(r => r.status === 'skipped').length,
    errors: results.filter(r => r.status === 'error').length,
    results,
  });
}
