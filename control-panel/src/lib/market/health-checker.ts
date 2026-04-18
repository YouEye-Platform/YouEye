/**
 * Health Checker — Background periodic health monitoring for installed apps.
 *
 * Checks each installed app's primary container for HTTP health every 5 minutes.
 * Updates the health_status and health_checked_at columns in installed_apps.
 *
 * Pattern: same setInterval + guard flag pattern as version-checker.ts
 */

import { getAllInstalledApps, updateHealthStatus } from './installed-apps';
import { readInstallMetadata } from './metadata';
import { containerExists, getContainerIP } from '../infrastructure/oci-deployer';
import { incusRequest } from '../incus/server';

/** Whether a check is currently running */
let isChecking = false;

/** Timestamp of the last completed check */
let lastCheckedAt: string | null = null;

/** Last check results */
let lastResults: Map<string, 'healthy' | 'unhealthy' | 'unknown'> = new Map();

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// ─── Public API ───────────────────────────────────────────────

export function getHealthStatus(appId: string): 'healthy' | 'unhealthy' | 'unknown' {
  return lastResults.get(appId) || 'unknown';
}

export function getAllHealthStatuses(): Record<string, 'healthy' | 'unhealthy' | 'unknown'> {
  return Object.fromEntries(lastResults);
}

export function getLastHealthCheckAt(): string | null {
  return lastCheckedAt;
}

export function isHealthCheckInProgress(): boolean {
  return isChecking;
}

// ─── Health Check Logic ──────────────────────────────────────

async function isContainerRunning(name: string): Promise<boolean> {
  try {
    if (!(await containerExists(name))) return false;
    const resp = await incusRequest<Record<string, unknown>>(
      'GET',
      `/1.0/instances/${name}/state`
    );
    const meta = resp.metadata as Record<string, unknown> | undefined;
    return (meta?.status as string) === 'Running';
  } catch {
    return false;
  }
}

async function checkAppHealth(
  containerName: string,
  port: number,
  path: string = '/',
): Promise<'healthy' | 'unhealthy'> {
  try {
    const ip = await getContainerIP(containerName);
    if (!ip) return 'unhealthy';

    const res = await fetch(`http://${ip}:${port}${path}`, {
      signal: AbortSignal.timeout(5000),
    });
    return res.ok || res.status === 401 || res.status === 403 ? 'healthy' : 'unhealthy';
  } catch {
    return 'unhealthy';
  }
}

/**
 * Run a full health check across all installed apps.
 */
export async function refreshHealthCheck(): Promise<void> {
  if (isChecking) return;

  isChecking = true;
  try {
    const apps = await getAllInstalledApps();

    for (const app of apps) {
      try {
        const metadata = await readInstallMetadata(app.appId);
        if (!metadata) {
          lastResults.set(app.appId, 'unknown');
          await updateHealthStatus(app.appId, 'unknown');
          continue;
        }

        // Find primary container
        const containers = metadata.containers || [];
        const primary = containers.find((c: any) =>
          typeof c === 'string' ? true : c.primary || containers.length === 1
        );
        const containerName = typeof primary === 'string'
          ? primary
          : primary?.containerName || `youeye-${app.appId}`;

        // Check if container is running
        const running = await isContainerRunning(containerName);
        if (!running) {
          lastResults.set(app.appId, 'unknown');
          await updateHealthStatus(app.appId, 'unknown');
          continue;
        }

        // HTTP health check on primary container (ContainerMeta doesn't store port, default to 3000)
        const port = 3000;
        const status = await checkAppHealth(containerName, port);
        lastResults.set(app.appId, status);
        await updateHealthStatus(app.appId, status);
      } catch {
        lastResults.set(app.appId, 'unknown');
        try { await updateHealthStatus(app.appId, 'unknown'); } catch {}
      }
    }

    lastCheckedAt = new Date().toISOString();
  } catch (err) {
    console.error('[health-checker] Check failed:', err);
  } finally {
    isChecking = false;
  }
}

// ─── Background Timer ─────────────────────────────────────────

let backgroundTimer: ReturnType<typeof setInterval> | null = null;

export function startHealthChecker(): void {
  if (backgroundTimer) return;

  // Initial check after 60 seconds (after version-checker at 45s)
  setTimeout(() => {
    refreshHealthCheck().catch((err) => {
      console.error('[health-checker] Initial check failed:', err);
    });
  }, 60_000);

  backgroundTimer = setInterval(() => {
    refreshHealthCheck().catch((err) => {
      console.error('[health-checker] Periodic check failed:', err);
    });
  }, CHECK_INTERVAL_MS);
}

export function stopHealthChecker(): void {
  if (backgroundTimer) {
    clearInterval(backgroundTimer);
    backgroundTimer = null;
  }
}

// Auto-start when module is imported in production
if (typeof process !== 'undefined' && process.env.NODE_ENV !== 'test') {
  startHealthChecker();
}
