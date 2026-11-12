/**
 * Orphan resource detector.
 * Cross-references installed apps against Caddy routes, PostgreSQL databases,
 * Incus instances, and custom volumes to find orphaned resources
 * from previous unclean uninstalls.
 */

import { listInstalledApps, listRetainedApps } from './metadata';
import { getRoutes, removeRoute } from '../caddy/client';
import type { InstallMetadata, OrphanResource } from './types';
import { INSTALLATION_TAG, readInstanceConfig } from './instance-ownership';

const DB_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

/** Exact names, installation ids and databases recorded by installed and retained apps. */
async function recordedOwnership() {
  const owned: InstallMetadata[] = [...await listInstalledApps(), ...await listRetainedApps()];
  return {
    containers: new Set(owned.flatMap((m) => [
      ...m.containers.map((c) => c.containerName),
      ...(m.retainedRoots?.roots ?? []).map((root) => root.retainedName),
    ])),
    installations: new Set(owned.map((m) => m.installationId).filter((id): id is string => Boolean(id))),
    databases: new Set(owned.flatMap((m) => [m.appId, ...(m.databaseName ? [m.databaseName] : [])])),
  };
}

// Known infrastructure containers/routes — never orphaned
const INFRA_CONTAINERS = new Set([
  'youeye-postgres',
  'youeye-caddy',
  'youeye-pihole',
  'youeye-ui',
  'youeye-pointer',
]);

/**
 * Detect orphaned resources across all services.
 * Read-only — never auto-cleans.
 */
export async function detectOrphans(): Promise<OrphanResource[]> {
  const orphans: OrphanResource[] = [];
  const installed = await listInstalledApps();
  const retained = await listRetainedApps();
  const owned = [...installed, ...retained];
  const installedAppIds = new Set(owned.flatMap(m => [m.appId, ...(m.databaseName ? [m.databaseName] : [])]));
  const installedContainers = new Set(owned.flatMap((m) =>
    m.containers.map((c: any) => typeof c === 'string' ? c : c.containerName)
  ));
  const installedSubdomains = new Set(
    installed
      .filter((m) => m.subdomain && m.domain)
      .map((m) => `${m.subdomain}.${m.domain}`)
  );
  for (const metadata of retained) {
    for (const root of metadata.retainedRoots?.roots ?? []) installedContainers.add(root.retainedName);
  }
  const installedVolumes = new Set(owned.flatMap((metadata) =>
    (metadata.storageVolumes ?? [])
      .filter((volume) => !volume.attachmentOnly)
      .map((volume) => `${volume.pool}/${volume.name}`)
  ));

  // 1. Orphaned Caddy routes
  try {
    const routes = await getRoutes();
    for (const route of routes) {
      if (!route.hostname) continue;
      // Skip infrastructure routes
      if (isInfraRoute(route.hostname)) continue;
      // If the hostname doesn't match any installed app subdomain
      if (!installedSubdomains.has(route.hostname) && !isKnownHostname(route.hostname, installedAppIds)) {
        orphans.push({
          type: 'caddy-route',
          identifier: route.hostname,
          detail: `Route ID: ${route.id}, upstream: ${route.upstream}`,
          action: 'can-remove',
        });
      }
    }
  } catch {
    // Caddy may be unavailable
  }

  // 2. Orphaned PostgreSQL databases
  try {
    const { execShell } = await import('../incus/server');
    const result = await execShell(
      'youeye-postgres',
      `psql -U youeye -tAc "SELECT datname FROM pg_database WHERE datistemplate = false AND datname NOT IN ('postgres', 'youeye')"`,
      { timeout: 10_000 }
    );

    if (result.exitCode === 0 && result.stdout) {
      const databases = result.stdout.trim().split('\n').filter(Boolean);
      for (const db of databases) {
        const dbName = db.trim();
        if (!dbName) continue;
        // Check if this DB belongs to any installed app
        if (!installedAppIds.has(dbName) && !isInfraDatabase(dbName)) {
          orphans.push({
            type: 'postgres-db',
            identifier: dbName,
            action: 'can-remove',
          });
        }
      }
    }
  } catch {
    // PostgreSQL may be unavailable
  }

  // 3. Orphaned containers: instances an install created (they carry an installation tag)
  // that no install record names. Untagged instances are not ours and are never offered.
  try {
    const { incusRequest } = await import('../incus/server');
    const resp = await incusRequest<Array<{ name?: string; config?: Record<string, string> }>>('GET', '/1.0/instances?recursion=1');
    const instances = Array.isArray(resp.metadata) ? resp.metadata : [];
    const installations = new Set(owned.map((m) => m.installationId).filter(Boolean));

    for (const instance of instances) {
      const name = instance.name || '';
      const installation = instance.config?.[INSTALLATION_TAG];
      if (!installation || INFRA_CONTAINERS.has(name)) continue;
      if (installedContainers.has(name) || installations.has(installation)) continue;
      orphans.push({
        type: 'container',
        identifier: name,
        action: 'can-remove',
      });
    }
  } catch {
    // Incus may be unavailable
  }

  // 4. Orphaned YouEye-owned Incus custom volumes
  try {
    const { incusRequest } = await import('../incus/server');
    const pools = await incusRequest<string[]>('GET', '/1.0/storage-pools');
    for (const poolPath of Array.isArray(pools.metadata) ? pools.metadata : []) {
      const pool = poolPath.split('/').pop() || '';
      if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(pool)) continue;
      const response = await incusRequest<Array<{
        name: string;
        type: string;
        config?: Record<string, string>;
        used_by?: string[];
      }>>('GET', `/1.0/storage-pools/${encodeURIComponent(pool)}/volumes/custom?recursion=1`);
      for (const volume of Array.isArray(response.metadata) ? response.metadata : []) {
        const kind = volume.config?.['user.youeye.kind'];
        if (volume.type !== 'custom' || (kind !== 'app' && kind !== 'shared')) continue;
        const identifier = `${pool}/${volume.name}`;
        if (installedVolumes.has(identifier)) continue;
        orphans.push({
          type: 'storage-volume',
          identifier,
          detail: (volume.used_by?.length ?? 0) > 0
            ? `YouEye-owned storage is still attached to ${volume.used_by!.length} instance(s)`
            : `Untracked YouEye-owned ${kind} storage`,
          action: 'can-remove',
        });
      }
    }
  } catch {
    // Storage inventory may be unavailable
  }

  return orphans;
}

/**
 * Clean up a single orphaned resource.
 */
export async function cleanupOrphan(orphan: OrphanResource): Promise<{ success: boolean; error?: string }> {
  try {
    switch (orphan.type) {
      case 'caddy-route': {
        const routes = await getRoutes();
        for (const route of routes) {
          if (route.hostname === orphan.identifier) {
            await removeRoute(route.id);
          }
        }
        return { success: true };
      }

      case 'postgres-db': {
        const name = orphan.identifier;
        if (!DB_IDENTIFIER.test(name) || isInfraDatabase(name) || ['postgres', 'youeye', 'youeye_ui'].includes(name)) {
          throw new Error('Not an app database identifier');
        }
        if ((await recordedOwnership()).databases.has(name)) throw new Error('Database belongs to an installed app');
        const { execCommand } = await import('../incus/server');
        for (const sql of [
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${name}' AND pid <> pg_backend_pid()`,
          `DROP DATABASE IF EXISTS "${name}"`,
          `DROP ROLE IF EXISTS "${name}"`,
        ]) {
          const result = await execCommand('youeye-postgres', ['psql', '-U', 'youeye', '-v', 'ON_ERROR_STOP=1', '-c', sql], { timeout: 10_000 });
          if (result.exitCode !== 0) throw new Error('Database cleanup failed');
        }
        return { success: true };
      }

      case 'container': {
        // Re-check at the write boundary: only an installation-tagged instance that no
        // install record names (by exact name or installation id) is deleted.
        const config = await readInstanceConfig(orphan.identifier);
        if (config === null) return { success: true };
        const installation = config[INSTALLATION_TAG];
        const recorded = await recordedOwnership();
        if (!installation || INFRA_CONTAINERS.has(orphan.identifier)
          || recorded.containers.has(orphan.identifier) || recorded.installations.has(installation)) {
          throw new Error('Instance is not an orphan of a YouEye install');
        }
        const { deleteOwnedInstance } = await import('./instance-ownership');
        await deleteOwnedInstance(orphan.identifier, { appId: config['user.youeye.app_id'] ?? '', installationId: installation });
        return { success: true };
      }

      case 'storage-volume': {
        const match = orphan.identifier.match(/^([a-z0-9][a-z0-9-]{0,62})\/([a-z0-9][a-z0-9-]{0,62})$/);
        if (!match) throw new Error('Invalid storage volume identifier');
        const [, pool, volume] = match;
        const { incusRequest: incReq } = await import('../incus/server');
        const current = await incReq<{
          config?: Record<string, string>;
          used_by?: string[];
        }>('GET', `/1.0/storage-pools/${encodeURIComponent(pool)}/volumes/custom/${encodeURIComponent(volume)}`);
        if (current.type === 'error' && (current.error_code === 404 || current.status_code === 404)) {
          return { success: true };
        }
        const kind = current.metadata?.config?.['user.youeye.kind'];
        if (kind !== 'app' && kind !== 'shared') throw new Error('Storage is not owned by YouEye');
        if ((current.metadata?.used_by?.length ?? 0) > 0) throw new Error('Storage is still attached to an instance');
        const deleted = await incReq('DELETE', `/1.0/storage-pools/${encodeURIComponent(pool)}/volumes/custom/${encodeURIComponent(volume)}`);
        if (deleted.type === 'error') throw new Error('Incus refused to delete app storage');
        if (deleted.type === 'async' && deleted.operation) {
          const waited = await incReq('GET', `${deleted.operation}/wait?timeout=60`, undefined, { timeout: 70_000 });
          if (waited.type === 'error') throw new Error('App storage deletion failed');
        }
        return { success: true };
      }

      case 'dns-entry': {
        // DNS entries typically just the app subdomain CNAME
        // Parse identifier as "subdomain.domain"
        const { removeCNAMERecord, getDNSRecords, removeDNSRecord } = await import('../apps/pihole-api');
        const dnsRecords = await getDNSRecords();
        for (const record of dnsRecords) {
          if (record.domain === orphan.identifier) {
            await removeDNSRecord(record.ip, record.domain);
          }
        }
        return { success: true };
      }

      default:
        return { success: false, error: `Unknown orphan type: ${orphan.type}` };
    }
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

/**
 * Clean up all detected orphaned resources.
 */
export async function cleanupAllOrphans(): Promise<{
  cleaned: number;
  failed: number;
  errors: string[];
}> {
  const orphans = await detectOrphans();
  let cleaned = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const orphan of orphans) {
    const result = await cleanupOrphan(orphan);
    if (result.success) {
      cleaned++;
    } else {
      failed++;
      if (result.error) {
        errors.push(`${orphan.type}:${orphan.identifier} — ${result.error}`);
      }
    }
  }

  return { cleaned, failed, errors };
}

// ─── Helpers ──────────────────────────────────────────────

function isInfraRoute(hostname: string): boolean {
  // Infrastructure hostnames: auth.*, panel.*, cp.*, dns.*, etc.
  const infraPrefixes = ['auth.', 'panel.', 'cp.', 'dns.', 'pihole.'];
  return infraPrefixes.some((p) => hostname.startsWith(p));
}

function isKnownHostname(hostname: string, appIds: Set<string>): boolean {
  // Check if the subdomain part matches any app ID
  const subdomain = hostname.split('.')[0];
  return appIds.has(subdomain);
}

function isInfraDatabase(name: string): boolean {
  const infraDbs = new Set(['pihole', 'pointer']);
  return infraDbs.has(name);
}
