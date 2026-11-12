/**
 * LXD App Version & Update Checking (UI and managed Pointer)
 *
 * - UI: a member of the accepted System release. Its version is that
 *   member's build version; it updates only with the System release.
 * - Pointer: installed version from its accepted product-release receipt;
 *   the candidate is the `pointer` entry of the box's channel index. A box
 *   never downgrades: an older channel head is reported, not offered.
 *
 * Results are cached in memory with a configurable TTL.
 */

import { compareVersions } from '@/lib/version';
import { describeReleaseError, readChannelIndex } from '@/lib/releases/channel-index';
import { selectedCoreRole } from '@/lib/releases/core-release';
import { getCoreProvenance } from '@/lib/updates/provenance';
import { APP_DEFINITIONS, type AppDefinition } from './definitions';

const CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours (must exceed the 3-hour background check interval)

export interface LxdUpdateResult {
  appId: string;
  installedVersion: string | undefined;
  latestVersion: string | undefined;
  latestTag?: string;
  hasUpdate: boolean;
  /** The channel head is older than the installed version; the box waits for it. */
  behind?: boolean;
  error?: string;
}

interface CacheEntry {
  result: LxdUpdateResult;
  cachedAt: number;
}

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
    if (Date.now() - entry.cachedAt <= CACHE_TTL_MS) results.set(id, entry.result);
  }
  return results;
}

export function clearLxdUpdateCache(appId: string): void {
  lxdCache.delete(appId);
}

async function check(appDef: AppDefinition): Promise<LxdUpdateResult> {
  if (appDef.id === 'ui') {
    const version = selectedCoreRole('ui').member.build_version;
    return { appId: appDef.id, installedVersion: version, latestVersion: version, hasUpdate: false };
  }
  if (appDef.id !== 'pointer') {
    return { appId: appDef.id, installedVersion: undefined, latestVersion: undefined, hasUpdate: false };
  }
  const installed = (await getCoreProvenance('app:pointer'))?.version;
  const entry = (await readChannelIndex()).index.products.pointer;
  if (!entry) return { appId: appDef.id, installedVersion: installed, latestVersion: undefined, hasUpdate: false };
  const order = installed ? compareVersions(entry.version, installed) : 1;
  return {
    appId: appDef.id,
    installedVersion: installed,
    latestVersion: entry.version,
    latestTag: entry.tag,
    hasUpdate: order > 0,
    behind: order < 0 || undefined,
  };
}

/** Check a single LXD app for version and updates. Results are cached. */
export async function checkLxdAppUpdate(appDef: AppDefinition, refresh = false): Promise<LxdUpdateResult> {
  if (!appDef.lxdConfig || appDef.containers.length === 0) {
    return { appId: appDef.id, installedVersion: undefined, latestVersion: undefined, hasUpdate: false };
  }
  if (!refresh) {
    const cached = getCachedLxdUpdate(appDef.id);
    if (cached) return cached;
  }
  let result: LxdUpdateResult;
  try {
    result = await check(appDef);
  } catch (error) {
    result = { appId: appDef.id, installedVersion: undefined, latestVersion: undefined, hasUpdate: false, error: describeReleaseError(error) };
  }
  lxdCache.set(appDef.id, { result, cachedAt: Date.now() });
  return result;
}

/** Check all LXD apps for updates. Returns a map of appId → result. */
export async function checkAllLxdUpdates(): Promise<Map<string, LxdUpdateResult>> {
  const lxdApps = APP_DEFINITIONS.filter((a) => a.lxdConfig && a.containers.length > 0);
  const results = await Promise.all(lxdApps.map((appDef) => checkLxdAppUpdate(appDef, true)));
  return new Map(results.map((result) => [result.appId, result]));
}
