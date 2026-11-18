/**
 * Version Checker — Background periodic checking for app version updates.
 *
 * Compares installed app versions against the catalog's latest versions.
 * Runs on a schedule and exposes results for the market UI.
 *
 * Pattern: same timer + guard flag pattern as update-cache.ts (every 6 hours plus 0–10 % jitter)
 */

import { checkForUpdates, migrateFromInstallJson, type InstalledApp } from './installed-apps';
import { clearCatalogCache } from './catalog';
import { refreshAllUpdates, withJitter } from '@/lib/apps/update-cache';
import { isDeploymentInProgress } from '@/lib/infrastructure/deployer';

/**
 * The checker's state, shared by every copy of this module in the process: Next bundles `instrumentation` (which
 * starts the checks) and the API routes (which read the results and start a check on request) separately;
 * module-level variables would give each copy its own (as in update-cache.ts).
 */
interface VersionCheckerState {
  /** Whether a check is currently running */
  checking: boolean;
  /** Timestamp of the last completed check */
  lastCheckedAt: string | null;
  /** Last check results */
  lastResults: InstalledApp[];
  timer: ReturnType<typeof setTimeout> | null;
}
const VERSION_CHECKER = Symbol.for('youeye.market-version-checker');
const checkerHolder = globalThis as typeof globalThis & { [VERSION_CHECKER]?: VersionCheckerState };
const checker = checkerHolder[VERSION_CHECKER] ??= { checking: false, lastCheckedAt: null, lastResults: [], timer: null };

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

// ─── Public API ───────────────────────────────────────────────

/**
 * Get the results of the last version check.
 */
export function getLastVersionCheckResults(): InstalledApp[] {
  return [...checker.lastResults];
}

/**
 * When the last version check completed.
 */
export function getLastVersionCheckAt(): string | null {
  return checker.lastCheckedAt;
}

/**
 * Whether a version check is in progress.
 */
export function isVersionCheckInProgress(): boolean {
  return checker.checking;
}

/**
 * Refresh the catalog cache and run version comparison.
 * Can be triggered manually from the UI.
 */
export async function refreshVersionCheck(): Promise<InstalledApp[]> {
  if (checker.checking) return checker.lastResults;
  if (isDeploymentInProgress()) {
    console.log('[version-checker] Skipping — infrastructure deployment in progress');
    return checker.lastResults;
  }

  checker.checking = true;
  try {
    // Clear catalog cache to get fresh data
    clearCatalogCache();

    // Check Market-installed + native apps via catalog
    const appsWithUpdates = await checkForUpdates();
    checker.lastResults = appsWithUpdates;
    checker.lastCheckedAt = new Date().toISOString();

    // Also refresh the UI and Pointer checks (update-cache) in the SAME pass, so a
    // single user action ("Check for updates") covers market apps + infra. A failure
    // here must not abort the market result.
    try {
      await refreshAllUpdates();
    } catch (err) {
      console.error('[version-checker] Infrastructure check failed:', err);
    }

    return appsWithUpdates;
  } catch (err) {
    console.error('[version-checker] Check failed:', err);
    return checker.lastResults;
  } finally {
    checker.checking = false;
  }
}

// ─── Background Timer ─────────────────────────────────────────

/**
 * Start the background periodic version checking.
 * Also runs install.json migration on first start.
 */
export function startVersionChecker(): void {
  if (checker.timer) return;

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

  const schedule = () => {
    checker.timer = setTimeout(() => {
      refreshVersionCheck()
        .catch((err) => {
          console.error('[version-checker] Periodic check failed:', err);
        })
        .finally(() => {
          if (checker.timer) schedule();
        });
    }, withJitter(CHECK_INTERVAL_MS));
  };
  schedule();
}

/**
 * Stop background version checking (for tests or shutdown).
 */
export function stopVersionChecker(): void {
  if (checker.timer) {
    clearTimeout(checker.timer);
    checker.timer = null;
  }
}

// NO module-import auto-start. instrumentation.ts is the single owner of
// background-job startup — an import side effect here started a second
// version-checker inside youeye-id.service and the two instances raced the
// installed-apps.json atomic rename (ENOENT on .tmp, devvm1 2026-07-02).
