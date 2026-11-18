/**
 * Shared helpers for the market engine.
 * Extracted to avoid circular dependencies between engine.ts, platform-env.ts, updater.ts.
 */

import { existsSync, readdirSync, statSync } from 'fs';
import path from 'path';

/**
 * Host paths a previous install of `appId` leaves behind: the app directory (install.json,
 * secrets) and the generated CA directory. A fresh install refuses while any exists; uninstall
 * with delete-data removes both.
 */
/** Leftover app directories that hold something. An empty directory holds no data and never blocks a reinstall. */
export function leftoverAppPaths(appId: string, baseDir = '/var/lib/youeye', exists: (file: string) => boolean = existsSync,
  isEmptyDirectory: (file: string) => boolean = emptyDirectory): string[] {
  return [path.join(baseDir, `app-${appId}`), path.join(baseDir, 'apps', appId)]
    .filter((candidate) => exists(candidate) && !isEmptyDirectory(candidate));
}

function emptyDirectory(file: string): boolean {
  try {
    return statSync(file).isDirectory() && readdirSync(file).length === 0;
  } catch {
    return false;
  }
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
