/**
 * OCI Registry Client & App Status Utilities
 *
 * Checks for OCI image updates by comparing manifest digests. Registry queries
 * are proxied through the Spine API on the host for consistency.
 */

import type { AppStatus } from '@/types/apps';
import { getAppManifests, getAppManifest } from './manifest';
import { spineClient } from '@/lib/spine/client';
import { APP_DEFINITIONS, type AppDefinition } from './definitions';

// ─── Legacy re-exports ────────────────────────────────────────────────────────
export { getAppManifest, getAppManifests };

/**
 * Parse container status string to AppStatus enum.
 */
export function containerStatusToAppStatus(containerStatus: string | undefined): AppStatus {
  if (!containerStatus) return 'not-installed';
  switch (containerStatus.toLowerCase()) {
    case 'running':
      return 'running';
    case 'stopped':
    case 'frozen':
      return 'stopped';
    case 'error':
      return 'error';
    default:
      return 'stopped';
  }
}

// ─── Digest types ─────────────────────────────────────────────────────────────

export interface DigestInfo {
  digest: string;
  checkedAt: string;
}

export interface UpdateCheckResult {
  appId: string;
  hasUpdate: boolean;
  currentDigest: string | null;
  latestDigest: string | null;
  error?: string;
}

/** In-memory baseline digest cache */
const digestCache = new Map<string, DigestInfo>();

/** Timestamp of last bulk check */
let lastBulkCheck: string | null = null;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function splitImageTag(imageRef: string): { image: string; tag: string } {
  const lastColon = imageRef.lastIndexOf(':');
  const lastSlash = imageRef.lastIndexOf('/');
  if (lastColon > lastSlash && lastColon !== -1) {
    return { image: imageRef.substring(0, lastColon), tag: imageRef.substring(lastColon + 1) };
  }
  return { image: imageRef, tag: 'latest' };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetch the current manifest digest for an app's OCI image via Spine proxy.
 */
export async function fetchRemoteDigest(appDef: AppDefinition): Promise<string> {
  if (!appDef.imageRef) throw new Error(`App ${appDef.id} has no imageRef`);
  const { image, tag } = splitImageTag(appDef.imageRef);
  const result = await spineClient.getRegistryDigest(image, tag);
  return result.digest;
}

export function getBaselineDigest(appId: string): DigestInfo | null {
  return digestCache.get(appId) ?? null;
}

export function setBaselineDigest(appId: string, digest: string): void {
  digestCache.set(appId, { digest, checkedAt: new Date().toISOString() });
}

export function clearBaselineDigest(appId: string): void {
  digestCache.delete(appId);
}

export function getLastBulkCheckTime(): string | null {
  return lastBulkCheck;
}

/**
 * Check a single OCI app for updates.
 * First-time: stores baseline digest, returns hasUpdate=false.
 * Subsequent: compares remote vs baseline.
 */
export async function checkAppUpdate(appDef: AppDefinition): Promise<UpdateCheckResult> {
  if (!appDef.imageRef) {
    return { appId: appDef.id, hasUpdate: false, currentDigest: null, latestDigest: null };
  }

  try {
    const remoteDigest = await fetchRemoteDigest(appDef);
    const baseline = getBaselineDigest(appDef.id);

    if (!baseline) {
      setBaselineDigest(appDef.id, remoteDigest);
      return { appId: appDef.id, hasUpdate: false, currentDigest: remoteDigest, latestDigest: remoteDigest };
    }

    return {
      appId: appDef.id,
      hasUpdate: baseline.digest !== remoteDigest,
      currentDigest: baseline.digest,
      latestDigest: remoteDigest,
    };
  } catch (error) {
    return {
      appId: appDef.id,
      hasUpdate: false,
      currentDigest: null,
      latestDigest: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Check all CP-managed OCI apps for updates in parallel.
 */
export async function checkAllUpdates(): Promise<Map<string, UpdateCheckResult>> {
  const ociApps = APP_DEFINITIONS.filter((a) => a.imageRef && a.updatedBy === 'control-panel');
  const results = await Promise.allSettled(ociApps.map((app) => checkAppUpdate(app)));
  const map = new Map<string, UpdateCheckResult>();

  results.forEach((result, i) => {
    const appId = ociApps[i].id;
    if (result.status === 'fulfilled') {
      map.set(appId, result.value);
    } else {
      map.set(appId, {
        appId,
        hasUpdate: false,
        currentDigest: null,
        latestDigest: null,
        error: result.reason?.message ?? 'Unknown error',
      });
    }
  });

  lastBulkCheck = new Date().toISOString();
  return map;
}
