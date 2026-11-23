/**
 * LXD App Version & Update Checking (UI and managed Pointer)
 *
 * - UI: a member of the accepted System release; it shows that release's
 *   version and updates only with the System release.
 * - Pointer: installed release from its accepted product-release receipt;
 *   the candidate is the release the `pointer` entry of the box's channel
 *   index names. Releases are ordered by line and sequence, never by name.
 *   A box never downgrades: an older channel head is reported, not offered.
 *
 * Results are cached in memory with a configurable TTL.
 */

import { compareReleases, releaseKey, type ReleaseKey } from '@/lib/version';
import { describeReleaseError, readChannelIndex, resolveChannelEntry } from '@/lib/releases/channel-index';
import { loadSelectedCore } from '@/lib/releases/core-release';
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

/**
 * The results, shared by every copy of this module in the process: Next bundles `instrumentation` (whose background
 * check fills it, update-cache.ts) and the API routes that read it (`/api/ui-bridge/apps`, `/api/apps/unified`)
 * separately, so a module-level Map would leave the routes reading their own empty copy.
 */
const LXD_CACHE = Symbol.for('youeye.lxd-update-cache');
const lxdCacheHolder = globalThis as typeof globalThis & { [LXD_CACHE]?: Map<string, CacheEntry> };
const lxdCache = lxdCacheHolder[LXD_CACHE] ??= new Map<string, CacheEntry>();

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
    const version = loadSelectedCore().version;
    return { appId: appDef.id, installedVersion: version, latestVersion: version, hasUpdate: false };
  }
  if (appDef.id !== 'pointer') {
    return { appId: appDef.id, installedVersion: undefined, latestVersion: undefined, hasUpdate: false };
  }
  const provenance = await getCoreProvenance('app:pointer');
  const installed: PointerInstalled | undefined = provenance
    ? {
      version: provenance.version, key: provenance.key ?? undefined, manifestSHA256: provenance.manifest_sha256 ?? undefined,
      artifactSHA256: provenance.artifact_sha256 ?? undefined,
    } : undefined;
  try {
    const entry = (await readChannelIndex()).index.products.pointer;
    if (!entry) return pointerUpdateState(installed, undefined);
    // The installed document needs no download; any other is read for its line, sequence and package.
    if (installed?.key && entry.sha256 === installed.manifestSHA256) {
      return pointerUpdateState(installed, { version: entry.version, tag: entry.tag, key: installed.key });
    }
    const selected = await resolveChannelEntry('pointer', entry);
    return pointerUpdateState(installed, {
      version: entry.version, tag: entry.tag, key: releaseKey(selected.release),
      artifactSHA256: selected.build.assets.find((asset) => asset.name === 'standalone.tar')?.sha256,
    });
  } catch (error) {
    // The channel could not be read: Pointer still shows what is installed.
    return { appId: 'pointer', installedVersion: installed?.version, latestVersion: undefined, hasUpdate: false, error: describeReleaseError(error) };
  }
}

type PointerInstalled = { version: string; key?: ReleaseKey; manifestSHA256?: string; artifactSHA256?: string };
type PointerCandidate = { version: string; tag: string; key: ReleaseKey; artifactSHA256?: string };

/**
 * Pointer's update state from its installed release and the channel's.
 * Releases are ordered by line and sequence, and only a newer build is an
 * update. The same build under another release name (the box changed channel,
 * or the build was promoted) is none: Pointer keeps showing the release it
 * installed until a newer build arrives (owner, 2026-11-23, YE-139); it is
 * never behind either. An install without a recorded release (an older
 * provenance record) is decided by its package when both are known (the same
 * package is the same build), else it is offered the channel's release.
 */
export function pointerUpdateState(installed: PointerInstalled | undefined, candidate: PointerCandidate | undefined): LxdUpdateResult {
  if (!candidate) return { appId: 'pointer', installedVersion: installed?.version, latestVersion: undefined, hasUpdate: false };
  const samePackage = !!installed?.artifactSHA256 && installed.artifactSHA256 === candidate.artifactSHA256;
  const order = installed?.key ? compareReleases(candidate.key, installed.key) : samePackage ? 0 : 1;
  return {
    appId: 'pointer',
    installedVersion: installed?.version,
    latestVersion: candidate.version,
    latestTag: candidate.tag,
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
