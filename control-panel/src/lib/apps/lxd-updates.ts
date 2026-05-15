/**
 * LXD App Version & Update Checking
 *
 * Fetches installed versions from container filesystems and checks for
 * newer releases on Gitea. Results are cached in memory with a configurable TTL.
 *
 * - Installed version: read package.json from inside the container via execShell
 * - Latest version: query Gitea releases API (branch-aware, with fallback to main)
 * - Cache: per-app results stored in memory, refreshed periodically
 */

import { execShell } from '@/lib/incus/server';
import { settingsService } from '@/lib/settings';
import { isNewer, sortVersionsDesc } from '@/lib/version';
import { APP_DEFINITIONS, type AppDefinition } from './definitions';

const GITHUB_API = 'https://api.github.com';
const GITHUB_ORG = 'YouEye-Platform';
const CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours (must exceed the 3-hour background check interval)

// ─── Types ───────────────────────────────────────────────────────────────────

export interface LxdUpdateResult {
  appId: string;
  installedVersion: string | undefined;
  latestVersion: string | undefined;
  hasUpdate: boolean;
  error?: string;
}

interface CacheEntry {
  result: LxdUpdateResult;
  cachedAt: number;
}

// ─── Cache ───────────────────────────────────────────────────────────────────

const lxdCache = new Map<string, CacheEntry>();

export function getCachedLxdUpdate(appId: string): LxdUpdateResult | null {
  const entry = lxdCache.get(appId);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > CACHE_TTL_MS) return null;
  return entry.result;
}

export function getAllCachedLxdUpdates(): Map<string, LxdUpdateResult> {
  const results = new Map<string, LxdUpdateResult>();
  for (const [id, entry] of lxdCache) {
    if (Date.now() - entry.cachedAt <= CACHE_TTL_MS) {
      results.set(id, entry.result);
    }
  }
  return results;
}

export function clearLxdUpdateCache(appId: string): void {
  lxdCache.delete(appId);
}

// ─── Version Fetching ────────────────────────────────────────────────────────

/**
 * Read the installed version from package.json inside the container.
 * Tries the configured appDir first, then falls back to the service file's
 * WorkingDirectory (handles deployments where the path differs from definition).
 * Returns undefined if the container is not running or the file doesn't exist.
 */
export async function getLxdAppVersion(
  containerName: string,
  appDir: string,
  serviceName?: string
): Promise<string | undefined> {
  // Try configured appDir first
  try {
    const result = await execShell(containerName, `cat ${appDir}/package.json`, {
      timeout: 5000,
    });
    if (result.exitCode === 0 && result.stdout) {
      const pkg = JSON.parse(result.stdout);
      if (pkg.version) return pkg.version;
    }
  } catch {
    // not found at appDir
  }

  // Fallback: read WorkingDirectory from the systemd service via systemctl show
  // (handles drop-in overrides, unlike grep on the unit file)
  if (serviceName) {
    try {
      const svcResult = await execShell(
        containerName,
        `systemctl show ${serviceName} -p WorkingDirectory --value`,
        { timeout: 5000 }
      );
      const actualDir = svcResult.stdout?.trim();
      if (actualDir && actualDir !== '' && actualDir !== '(null)' && actualDir !== appDir) {
        const result = await execShell(containerName, `cat ${actualDir}/package.json`, {
          timeout: 5000,
        });
        if (result.exitCode === 0 && result.stdout) {
          const pkg = JSON.parse(result.stdout);
          if (pkg.version) return pkg.version;
        }
      }
    } catch {
      // systemctl show failed or parse error
    }
  }

  return undefined;
}

/**
 * Get the latest release version for an LXD app from Gitea.
 * Branch-aware: checks for branch-prefixed tags first, then falls back to main.
 *
 * Fetches releases from inside an available container (CP's youeye-control) since
 * the CP process may not have direct internet access. Falls back to Node.js fetch.
 */
export async function getLxdAppLatestVersion(
  giteaRepo: string,
  releaseBranch?: string,
  tagPrefix?: string
): Promise<string | undefined> {
  const releasesURL = `${GITHUB_API}/repos/${GITHUB_ORG}/${giteaRepo}/releases?per_page=50`;

  let releasesJson: string | undefined;

  // Try fetching from CP container first (has internet via host proxy)
  try {
    const result = await execShell('youeye-control', `curl -sSL -H 'User-Agent: youeye-spine' -H 'Accept: application/vnd.github+json' '${releasesURL}'`, {
      timeout: 15_000,
    });
    if (result.exitCode === 0 && result.stdout) {
      releasesJson = result.stdout;
    }
  } catch {
    // CP container might not be available
  }

  // Fallback: try Node.js fetch directly
  if (!releasesJson) {
    try {
      const resp = await fetch(releasesURL, { signal: AbortSignal.timeout(10_000) });
      if (resp.ok) {
        releasesJson = await resp.text();
      }
    } catch {
      // No network access from CP
    }
  }

  if (!releasesJson) return undefined;

  try {
    const allReleases = JSON.parse(releasesJson);
    if (!Array.isArray(allReleases) || allReleases.length === 0) return undefined;

    const branch = releaseBranch || '';

    // Strip component tag prefix (e.g. "ui-v0.2.21" → "v0.2.21") and filter
    const pfx = tagPrefix ? `${tagPrefix}-` : '';
    const releases = pfx
      ? allReleases
          .filter((r: { tag_name: string }) => r.tag_name.startsWith(pfx))
          .map((r: { tag_name: string }) => ({ ...r, tag_name: r.tag_name.slice(pfx.length) }))
      : allReleases;

    // Collect main releases (always needed for comparison)
    const mainReleases = releases.filter((r: { tag_name: string }) =>
      /^v\d/.test(r.tag_name)
    );
    const bestMain = mainReleases.length > 0
      ? sortVersionsDesc(mainReleases.map((r: { tag_name: string }) => r.tag_name.replace(/^v/, '')))[0]
      : undefined;

    // Try branch-specific releases
    if (branch && branch !== 'main') {
      const prefix = `${branch}-v`;
      const branchReleases = releases.filter(
        (r: { tag_name: string }) => r.tag_name.startsWith(prefix)
      );
      if (branchReleases.length > 0) {
        const bestBranch = sortVersionsDesc(
          branchReleases.map((r: { tag_name: string }) => r.tag_name.replace(prefix, ''))
        )[0];
        // Compare branch winner vs main winner — use whichever is newer
        if (bestMain && isNewer(bestMain, bestBranch)) {
          return bestMain;
        }
        return bestBranch;
      }
    }

    // No branch releases found — use main
    if (bestMain) {
      return bestMain;
    }
  } catch {
    // JSON parse error
  }

  return undefined;
}

// ─── Combined Check ──────────────────────────────────────────────────────────

/**
 * Check a single LXD app for version and updates. Results are cached.
 */
export async function checkLxdAppUpdate(appDef: AppDefinition): Promise<LxdUpdateResult> {
  if (!appDef.lxdConfig || appDef.containers.length === 0) {
    return { appId: appDef.id, installedVersion: undefined, latestVersion: undefined, hasUpdate: false };
  }

  // Return cached result if fresh
  const cached = getCachedLxdUpdate(appDef.id);
  if (cached) return cached;

  const containerName = appDef.containers[0].name;
  const { giteaRepo, tagPrefix, appDir, serviceName } = appDef.lxdConfig;

  try {
    // Get release branch from Spine config
    let releaseBranch = '';
    try {
      const config = await settingsService.getRaw();
      releaseBranch = config.release_branch || '';
    } catch {
      // default to main
    }

    // Fetch installed + latest in parallel
    const [installed, latest] = await Promise.all([
      getLxdAppVersion(containerName, appDir, serviceName),
      getLxdAppLatestVersion(giteaRepo, releaseBranch, tagPrefix),
    ]);

    const hasUpdate = !!(installed && latest && isNewer(latest, installed));

    const result: LxdUpdateResult = {
      appId: appDef.id,
      installedVersion: installed,
      latestVersion: latest,
      hasUpdate,
    };

    // Cache the result
    lxdCache.set(appDef.id, { result, cachedAt: Date.now() });

    return result;
  } catch (error) {
    const result: LxdUpdateResult = {
      appId: appDef.id,
      installedVersion: undefined,
      latestVersion: undefined,
      hasUpdate: false,
      error: error instanceof Error ? error.message : String(error),
    };
    // Cache errors too (with normal TTL) to avoid spamming
    lxdCache.set(appDef.id, { result, cachedAt: Date.now() });
    return result;
  }
}

/**
 * Check all LXD apps for updates. Returns a map of appId → result.
 */
export async function checkAllLxdUpdates(): Promise<Map<string, LxdUpdateResult>> {
  const lxdApps = APP_DEFINITIONS.filter(
    (a) => a.lxdConfig && a.containers.length > 0
  );

  // Get release branch once for all apps
  let releaseBranch = '';
  try {
    const config = await settingsService.getRaw();
    releaseBranch = config.release_branch || '';
  } catch {
    // default to main
  }

  const results = await Promise.allSettled(
    lxdApps.map(async (appDef) => {
      const containerName = appDef.containers[0].name;
      const { giteaRepo, tagPrefix, appDir, serviceName } = appDef.lxdConfig!;

      const [installed, latest] = await Promise.all([
        getLxdAppVersion(containerName, appDir, serviceName),
        getLxdAppLatestVersion(giteaRepo, releaseBranch, tagPrefix),
      ]);

      const hasUpdate = !!(installed && latest && isNewer(latest, installed));

      const result: LxdUpdateResult = {
        appId: appDef.id,
        installedVersion: installed,
        latestVersion: latest,
        hasUpdate,
      };

      lxdCache.set(appDef.id, { result, cachedAt: Date.now() });
      return result;
    })
  );

  const map = new Map<string, LxdUpdateResult>();
  results.forEach((r, i) => {
    const appId = lxdApps[i].id;
    if (r.status === 'fulfilled') {
      map.set(appId, r.value);
    } else {
      const errorResult: LxdUpdateResult = {
        appId,
        installedVersion: undefined,
        latestVersion: undefined,
        hasUpdate: false,
        error: r.reason?.message ?? 'Unknown error',
      };
      lxdCache.set(appId, { result: errorResult, cachedAt: Date.now() });
      map.set(appId, errorResult);
    }
  });

  return map;
}
