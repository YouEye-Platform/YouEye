/**
 * Update Cache
 *
 * Background periodic checking for updates of the UI and Pointer (their LXD checks, lxd-updates.ts). Market apps are
 * checked by the Market's version checker; Caddy, Pi-Hole and PostgreSQL follow the images pinned by this release.
 *
 * - Checks about every 3 hours (plus 0–10 % jitter) once `startBackgroundChecks()` runs; instrumentation.ts starts
 *   it, never an import of this module.
 * - Manual refresh via refreshAllUpdates()
 */

import { checkAllLxdUpdates, clearLxdUpdateCache } from './lxd-updates';
import { isDeploymentInProgress } from '@/lib/infrastructure/deployer';

/**
 * The checker's state, shared by every copy of this module in the process: Next bundles `instrumentation` (which
 * starts the checks) and the API routes (which report `lastCheckedAt` and `checkInProgress`) separately; module-level
 * variables would give each copy its own. The results themselves are shared the same way in lxd-updates.ts.
 */
interface CheckerState {
  /** Whether a check is currently running */
  checking: boolean;
  /** Timestamp of the last completed check */
  lastCheckedAt: string | null;
  timer: ReturnType<typeof setTimeout> | null;
}
const CHECKER = Symbol.for('youeye.app-update-checker');
const checkerHolder = globalThis as typeof globalThis & { [CHECKER]?: CheckerState };
const checker = checkerHolder[CHECKER] ??= { checking: false, lastCheckedAt: null, timer: null };

const CHECK_INTERVAL_MS = 3 * 60 * 60 * 1000; // 3 hours

/**
 * `intervalMs` plus 0–10 % jitter, so boxes started together do not all ask at the same moment.
 * `random` is a value in [0, 1).
 */
export function withJitter(intervalMs: number, random: number = Math.random()): number {
  const fraction = Number.isFinite(random) ? Math.min(Math.max(random, 0), 1) : 0;
  return Math.round(intervalMs * (1 + 0.1 * fraction));
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** When the last check completed */
export function getLastCheckedAt(): string | null {
  return checker.lastCheckedAt;
}

/** Whether a check is in progress */
export function isCheckInProgress(): boolean {
  return checker.checking;
}

/**
 * Check the UI and Pointer for updates now. Also triggered by the Market's "Check for updates". Their results are
 * kept by lxd-updates.ts (`getAllCachedLxdUpdates`).
 */
export async function refreshAllUpdates(): Promise<void> {
  if (checker.checking) return;
  if (isDeploymentInProgress()) {
    console.log('[update-cache] Skipping — infrastructure deployment in progress');
    return;
  }

  checker.checking = true;
  try {
    await checkAllLxdUpdates();
    checker.lastCheckedAt = new Date().toISOString();
    // The UI reports the installed release. The publisher (installed-release.ts) writes it when the release changes;
    // this pass also restores it when the UI container was replaced without a release change.
    void import('@/lib/releases/installed-release').then(({ publishUIRelease }) => publishUIRelease())
      .catch((error) => console.warn('[update-cache] The UI release version was not published:', error));
  } finally {
    checker.checking = false;
  }
}

/** Call after a successful update, so the next check compares against what was just deployed. */
export function markAppUpdated(appId: string): void {
  clearLxdUpdateCache(appId);
}

// ─── Background Timer ─────────────────────────────────────────────────────────

/** Start the background periodic checking. Called once, by instrumentation.ts. */
export function startBackgroundChecks(): void {
  if (checker.timer) return;

  const schedule = (delayMs: number) => {
    checker.timer = setTimeout(() => {
      refreshAllUpdates()
        .catch((err) => {
          console.error('[update-cache] Periodic check failed:', err);
        })
        .finally(() => {
          if (checker.timer) schedule(withJitter(CHECK_INTERVAL_MS));
        });
    }, delayMs);
  };

  // First check shortly after the server boots, then about every three hours.
  schedule(30_000);
}

/** Stop background checking (for tests or shutdown) */
export function stopBackgroundChecks(): void {
  if (checker.timer) {
    clearTimeout(checker.timer);
    checker.timer = null;
  }
}

// NO module-import auto-start: instrumentation.ts owns every background job (an import side effect started this
// checker inside youeye-id.service too).
