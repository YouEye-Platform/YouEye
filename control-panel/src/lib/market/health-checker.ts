/**
 * Health Checker — Background periodic health monitoring for installed apps.
 *
 * Probes each installed app about every 30 seconds (jittered, so it never runs in step with the
 * health monitor) and publishes the result. Probes only read; restarts go to the app reconcile queue.
 */

import { APP_PROBER_DEFAULT_PERIOD_MS, getAppProbeResults, probeInstalledApps, resetHealthyBackoff } from './app-prober';
import { reconcileApps } from './reconciler';
import { startJitteredLoop } from '@/lib/health/jittered-timer';

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

let stopBackgroundTimer: (() => void) | null = null;

export function startHealthChecker(): void {
  if (stopBackgroundTimer) return;

  // First check 60–90 s after start (after version-checker at 45s), then every 30 s ±15 %.
  stopBackgroundTimer = startJitteredLoop(() => {
    refreshHealthCheck().catch((err) => {
      console.error('[health-checker] Periodic check failed:', err);
    });
  }, { periodMs: CHECK_INTERVAL_MS });
}

export function stopHealthChecker(): void {
  stopBackgroundTimer?.();
  stopBackgroundTimer = null;
}

// NO module-import auto-start. instrumentation.ts is the single owner of
// background-job startup (see version-checker.ts for the youeye-id race
// this pattern caused).
