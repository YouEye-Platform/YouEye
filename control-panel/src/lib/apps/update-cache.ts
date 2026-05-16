/**
 * Update Cache
 *
 * Background periodic checking for OCI image updates. Stores results in memory
 * and provides a fast-read interface for the API layer.
 *
 * - Checks every 3 hours automatically (via setInterval in the module scope)
 * - Manual refresh via refreshAllUpdates()
 * - Individual app refresh via refreshAppUpdate(appId)
 */

import { APP_DEFINITIONS, getAppDefinition } from './definitions';
import {
  checkAllUpdates,
  checkAppUpdate,
  clearBaselineDigest,
  type UpdateCheckResult,
} from './registry';
import { checkAllLxdUpdates, clearLxdUpdateCache } from './lxd-updates';
import { isDeploymentInProgress } from '@/lib/infrastructure/deployer';

/** Cached update results keyed by appId */
const updateResults = new Map<string, UpdateCheckResult>();

/** Whether a background check is currently running */
let isChecking = false;

/** Timestamp of the last completed check */
let lastCheckedAt: string | null = null;

const CHECK_INTERVAL_MS = 3 * 60 * 60 * 1000; // 3 hours

// ─── Public API ───────────────────────────────────────────────────────────────

/** Get cached update status for a single app */
export function getCachedUpdate(appId: string): UpdateCheckResult | null {
  return updateResults.get(appId) ?? null;
}

/** Get all cached update results */
export function getAllCachedUpdates(): Map<string, UpdateCheckResult> {
  return new Map(updateResults);
}

/** Whether any app has an available update */
export function hasAnyUpdate(): boolean {
  for (const r of updateResults.values()) {
    if (r.hasUpdate) return true;
  }
  return false;
}

/** Get IDs of apps with available updates */
export function getAppsWithUpdates(): string[] {
  const ids: string[] = [];
  for (const [id, r] of updateResults) {
    if (r.hasUpdate) ids.push(id);
  }
  return ids;
}

/** When the last check completed */
export function getLastCheckedAt(): string | null {
  return lastCheckedAt;
}

/** Whether a check is in progress */
export function isCheckInProgress(): boolean {
  return isChecking;
}

/**
 * Refresh update status for all OCI apps. Can be triggered manually from the UI.
 * Returns the fresh results.
 */
export async function refreshAllUpdates(): Promise<Map<string, UpdateCheckResult>> {
  if (isChecking) {
    return updateResults;
  }
  if (isDeploymentInProgress()) {
    console.log('[update-cache] Skipping — infrastructure deployment in progress');
    return updateResults;
  }

  isChecking = true;
  try {
    // Check OCI and LXD updates in parallel.
    // OCI results go into updateResults (this cache).
    // LXD results go into lxdCache (lxd-updates.ts) — read via getAllCachedLxdUpdates().
    const [ociResults] = await Promise.allSettled([
      checkAllUpdates(),
      checkAllLxdUpdates(),
    ]);

    const results = ociResults.status === 'fulfilled' ? ociResults.value : new Map<string, UpdateCheckResult>();
    for (const [id, result] of results) {
      updateResults.set(id, result);
    }
    lastCheckedAt = new Date().toISOString();
    return results;
  } finally {
    isChecking = false;
  }
}

/**
 * Refresh update status for a single app.
 */
export async function refreshAppUpdate(appId: string): Promise<UpdateCheckResult | null> {
  const appDef = getAppDefinition(appId);
  if (!appDef || !appDef.imageRef) return null;

  const result = await checkAppUpdate(appDef);
  updateResults.set(appId, result);
  return result;
}

/**
 * Call after a successful update to reset the baseline digest so subsequent
 * checks compare against the newly-deployed image.
 */
export function markAppUpdated(appId: string): void {
  clearBaselineDigest(appId);
  clearLxdUpdateCache(appId);
  updateResults.delete(appId);
}

// ─── Background Timer ─────────────────────────────────────────────────────────

let backgroundTimer: ReturnType<typeof setInterval> | null = null;

/** Start the background periodic checking (called once at module load) */
export function startBackgroundChecks(): void {
  if (backgroundTimer) return;

  // Initial check after a short delay (let the server boot)
  setTimeout(() => {
    refreshAllUpdates().catch((err) => {
      console.error('[update-cache] Initial check failed:', err);
    });
  }, 30_000); // 30 seconds after startup

  backgroundTimer = setInterval(() => {
    refreshAllUpdates().catch((err) => {
      console.error('[update-cache] Periodic check failed:', err);
    });
  }, CHECK_INTERVAL_MS);
}

/** Stop background checking (for tests or shutdown) */
export function stopBackgroundChecks(): void {
  if (backgroundTimer) {
    clearInterval(backgroundTimer);
    backgroundTimer = null;
  }
}

// Auto-start when module is imported in production
if (typeof process !== 'undefined' && process.env.NODE_ENV !== 'test') {
  startBackgroundChecks();
}
