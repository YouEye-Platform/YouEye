/**
 * Orphan resource detector.
 * Cross-references installed apps against Caddy routes, Authentik apps,
 * PostgreSQL databases, and volume directories to find orphaned resources
 * from previous unclean uninstalls.
 */

import { listInstalledApps } from './metadata';
import { getRoutes, removeRoute } from '../caddy/client';
import type { OrphanResource } from './types';

// Known infrastructure containers/routes — never orphaned
const INFRA_CONTAINERS = new Set([
  'youeye-authentik',
  'youeye-postgres',
  'youeye-caddy',
  'youeye-pihole',
  'youeye-ui',
]);

const INFRA_SLUGS = new Set([
  'youeye-ui',
  'youeye-admin',
]);

/**
 * Detect orphaned resources across all services.
 * Read-only — never auto-cleans.
 */
export async function detectOrphans(): Promise<OrphanResource[]> {
  const orphans: OrphanResource[] = [];
  const installed = await listInstalledApps();
  const installedAppIds = new Set(installed.map((m) => m.appId));
  const installedContainers = new Set(installed.flatMap((m) =>
    m.containers.map((c: any) => typeof c === 'string' ? c : c.containerName)
  ));
  const installedSubdomains = new Set(
    installed
      .filter((m) => m.subdomain && m.domain)
      .map((m) => `${m.subdomain}.${m.domain}`)
  );
  const installedSsoSlugs = new Set(
    installed
      .filter((m) => m.ssoSlug)
      .map((m) => m.ssoSlug!)
  );

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

  // 2. Orphaned Authentik apps
  try {
    const { authentikAPI, getAuthentikConfig } = await import('./authentik');
    const config = await getAuthentikConfig();

    const appsResp = await authentikAPI<{ results: Array<{ slug: string; name: string; pk: string }> }>(
      config,
      '/api/v3/core/applications/?page_size=100'
    );

    for (const app of appsResp.results) {
      if (INFRA_SLUGS.has(app.slug)) continue;
      // Check if app slug matches any installed app's SSO slug
      if (!installedSsoSlugs.has(app.slug) && !isInfraSsoSlug(app.slug)) {
        orphans.push({
          type: 'authentik-app',
          identifier: app.slug,
          detail: `Name: ${app.name}`,
          action: 'can-remove',
        });
      }
    }
  } catch {
    // Authentik may be unavailable
  }

  // 3. Orphaned PostgreSQL databases
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

  // 4. Orphaned containers (app-* that aren't tracked)
  try {
    const { incusRequest } = await import('../incus/server');
    const resp = await incusRequest<string[]>('GET', '/1.0/instances');
    const instancePaths: string[] = Array.isArray(resp.metadata) ? resp.metadata : [];

    for (const path of instancePaths) {
      const name = path.split('/').pop() || '';
      if (!name.startsWith('app-') && !name.startsWith('ye-app-')) continue;
      if (INFRA_CONTAINERS.has(name)) continue;
      if (installedContainers.has(name)) continue;
      orphans.push({
        type: 'container',
        identifier: name,
        action: 'can-remove',
      });
    }
  } catch {
    // Incus may be unavailable
  }

  // 5. Orphaned volume directories
  try {
    const { readdir } = await import('fs/promises');
    const { existsSync } = await import('fs');

    // Check /var/lib/youeye/app-* directories
    if (existsSync('/var/lib/youeye')) {
      const entries = await readdir('/var/lib/youeye');
      for (const entry of entries) {
        if (!entry.startsWith('app-')) continue;
        const appId = entry.slice(4);
        if (installedAppIds.has(appId)) continue;
        // Check if there's an install.json (orphaned metadata = orphaned volume)
        if (!existsSync(`/var/lib/youeye/${entry}/install.json`)) {
          orphans.push({
            type: 'volume-dir',
            identifier: `/var/lib/youeye/${entry}`,
            detail: `App: ${appId}`,
            action: 'can-remove',
          });
        }
      }
    }

    // Check /var/lib/youeye/apps/* directories
    if (existsSync('/var/lib/youeye/apps')) {
      const entries = await readdir('/var/lib/youeye/apps');
      for (const entry of entries) {
        if (installedAppIds.has(entry)) continue;
        orphans.push({
          type: 'volume-dir',
          identifier: `/var/lib/youeye/apps/${entry}`,
          detail: `App: ${entry}`,
          action: 'can-remove',
        });
      }
    }
  } catch {
    // Filesystem scan failed
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

      case 'authentik-app': {
        const { removeAuthentikOAuth2App } = await import('./sso-engine');
        await removeAuthentikOAuth2App(orphan.identifier);
        return { success: true };
      }

      case 'postgres-db': {
        const { execShell } = await import('../incus/server');
        await execShell(
          'youeye-postgres',
          `psql -U youeye -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${orphan.identifier}' AND pid <> pg_backend_pid();"`,
          { timeout: 10_000 }
        );
        await execShell(
          'youeye-postgres',
          `psql -U youeye -c "DROP DATABASE IF EXISTS ${orphan.identifier}"`,
          { timeout: 10_000 }
        );
        await execShell(
          'youeye-postgres',
          `psql -U youeye -c "DROP USER IF EXISTS ${orphan.identifier}"`,
          { timeout: 10_000 }
        );
        return { success: true };
      }

      case 'container': {
        const { incusRequest: incReq } = await import('../incus/server');
        try {
          await incReq('PUT', `/1.0/instances/${orphan.identifier}/state`, {
            action: 'stop',
            force: true,
            timeout: 30,
          });
          await new Promise((r) => setTimeout(r, 3000));
        } catch {
          // May already be stopped
        }
        const result = await incReq('DELETE', `/1.0/instances/${orphan.identifier}`);
        if (result.type === 'async' && result.operation) {
          await incReq('GET', `${result.operation}/wait?timeout=30`, undefined, {
            timeout: 40_000,
          });
        }
        return { success: true };
      }

      case 'volume-dir': {
        const { rm } = await import('fs/promises');
        await rm(orphan.identifier, { recursive: true, force: true });
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

function isInfraSsoSlug(slug: string): boolean {
  return slug.startsWith('youeye-') && !slug.startsWith('youeye-app-');
}

function isInfraDatabase(name: string): boolean {
  const infraDbs = new Set(['authentik', 'pihole']);
  return infraDbs.has(name);
}
