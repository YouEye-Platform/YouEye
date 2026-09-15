/**
 * Health Checker — Background periodic health monitoring for installed apps.
 *
 * Checks each installed app's primary container for HTTP health every 5 minutes.
 * Updates the health_status and health_checked_at columns in installed_apps.
 *
 * Pattern: same setInterval + guard flag pattern as version-checker.ts
 */

import { APP_PROBER_DEFAULT_PERIOD_MS, getAppProbeResults, probeInstalledApps, resetHealthyBackoff } from './app-prober';
import { reconcileApps } from './reconciler';

/** Whether a check is currently running */
let isChecking = false;

/** Timestamp of the last completed check */
let lastCheckedAt: string | null = null;

/** Last check results */
const lastResults: Map<string, 'healthy' | 'unhealthy' | 'unknown'> = new Map();

const CHECK_INTERVAL_MS = APP_PROBER_DEFAULT_PERIOD_MS;

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

export function getAppProbeStatus() {
  return getAppProbeResults();
}

export function isHealthCheckInProgress(): boolean {
  return isChecking;
}

/**
 * Run a full health check across all installed apps.
 */
export async function refreshHealthCheck(): Promise<void> {
  if (isChecking) return;

  isChecking = true;
  try {
    const probeResults = await probeInstalledApps();
    for (const result of probeResults) {
      const status = result.state === 'running'
        ? 'healthy'
        : result.state === 'unhealthy' || result.state === 'crash-looping'
          ? 'unhealthy'
          : 'unknown';
      lastResults.set(result.appId, status);
    }
    await resetHealthyBackoff();
    await reconcileApps();

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

// NO module-import auto-start. instrumentation.ts is the single owner of
// background-job startup (see version-checker.ts for the youeye-id race
// this pattern caused).
