/**
 * Shared helpers for the market engine.
 * Extracted to avoid circular dependencies between engine.ts, platform-env.ts, updater.ts.
 */

import { existsSync } from 'fs';
import path from 'path';

/**
 * Host paths a previous install of `appId` leaves behind: the app directory (install.json,
 * secrets) and the generated CA directory. A fresh install refuses while any exists; uninstall
 * with delete-data removes both.
 */
export function leftoverAppPaths(appId: string, baseDir = '/var/lib/youeye', exists: (file: string) => boolean = existsSync): string[] {
  return [path.join(baseDir, `app-${appId}`), path.join(baseDir, 'apps', appId)].filter((candidate) => exists(candidate));
}

/**
 * Compute the Incus container name for an app's container.
 * Single-container apps: app-{appId}
 * Multi-container apps: app-{appId}-{containerName}
 */
export function getContainerName(appId: string, containerName: string, totalContainers: number): string {
  if (totalContainers <= 1) {
    return `app-${appId}`;
  }
  return `app-${appId}-${containerName}`;
}
