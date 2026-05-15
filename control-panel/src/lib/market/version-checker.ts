/**
 * Version Checker — Background periodic checking for app version updates.
 *
 * Compares installed app versions against the catalog's latest versions.
 * Runs on a schedule and exposes results for the market UI.
 *
 * Pattern: same setInterval + guard flag pattern as update-cache.ts
 */

import { checkForUpdates, migrateFromInstallJson, type InstalledApp } from './installed-apps';
import { clearCatalogCache } from './catalog';
import { refreshAllUpdates } from '@/lib/apps/update-cache';

/** Whether a check is currently running */
let isChecking = false;

/** Timestamp of the last completed check */
let lastCheckedAt: string | null = null;

/** Last check results */
let lastResults: InstalledApp[] = [];

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

// ─── Public API ───────────────────────────────────────────────

/**
 * Get the results of the last version check.
 */
export function getLastVersionCheckResults(): InstalledApp[] {
  return [...lastResults];
}

/**
 * When the last version check completed.
 */
export function getLastVersionCheckAt(): string | null {
  return lastCheckedAt;
}

/**
 * Whether a version check is in progress.
 */
export function isVersionCheckInProgress(): boolean {
  return isChecking;
}

/**
 * Refresh the catalog cache and run version comparison.
 * Can be triggered manually from the UI.
 */
export async function refreshVersionCheck(): Promise<InstalledApp[]> {
  if (isChecking) return lastResults;

  isChecking = true;
  try {
    // Clear catalog cache to get fresh data
    clearCatalogCache();

    // Check marketplace + native apps via catalog
    const appsWithUpdates = await checkForUpdates();
    lastResults = appsWithUpdates;
    lastCheckedAt = new Date().toISOString();

    // Also trigger infrastructure (OCI + LXD) update checks
    refreshAllUpdates().catch((err) => {
      console.error('[version-checker] Infrastructure check failed:', err);
    });

    return appsWithUpdates;
  } catch (err) {
    console.error('[version-checker] Check failed:', err);
    return lastResults;
  } finally {
    isChecking = false;
  }
}

// ─── Background Timer ─────────────────────────────────────────

let backgroundTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start the background periodic version checking.
 * Also runs install.json migration on first start.
 */
export function startVersionChecker(): void {
  if (backgroundTimer) return;

  // Initial: migrate install.json, then check versions after a delay
  setTimeout(async () => {
    try {
      await migrateFromInstallJson();
    } catch (err) {
      console.error('[version-checker] Migration failed:', err);
    }

    try {
      await refreshVersionCheck();
    } catch (err) {
      console.error('[version-checker] Initial check failed:', err);
    }
  }, 45_000); // 45 seconds after startup (after update-cache at 30s)

  backgroundTimer = setInterval(() => {
    refreshVersionCheck().catch((err) => {
      console.error('[version-checker] Periodic check failed:', err);
    });
  }, CHECK_INTERVAL_MS);
}

/**
 * Stop background version checking (for tests or shutdown).
 */
export function stopVersionChecker(): void {
  if (backgroundTimer) {
    clearInterval(backgroundTimer);
    backgroundTimer = null;
  }
}

// Auto-start when module is imported in production
if (typeof process !== 'undefined' && process.env.NODE_ENV !== 'test') {
  startVersionChecker();
}
