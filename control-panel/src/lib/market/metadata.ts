/**
 * Install metadata persistence for the App Market.
 * Stores install config at /var/lib/youeye/app-{appId}/install.json
 */

import { readFile, writeFile, mkdir, rm } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import type { InstallMetadata } from './types';

const BASE_DIR = '/var/lib/youeye';

function metadataDir(appId: string): string {
  return path.join(BASE_DIR, `app-${appId}`);
}

function metadataPath(appId: string): string {
  return path.join(metadataDir(appId), 'install.json');
}

export async function saveInstallMetadata(meta: InstallMetadata): Promise<void> {
  const dir = metadataDir(meta.appId);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }
  await writeFile(metadataPath(meta.appId), JSON.stringify(meta, null, 2), { mode: 0o600 });
}

export async function readInstallMetadata(appId: string): Promise<InstallMetadata | null> {
  try {
    const data = await readFile(metadataPath(appId), 'utf-8');
    return JSON.parse(data) as InstallMetadata;
  } catch {
    return null;
  }
}

export async function removeInstallMetadata(appId: string): Promise<void> {
  const dir = metadataDir(appId);
  try {
    if (existsSync(dir)) {
      await rm(dir, { recursive: true, force: true });
    }
  } catch {
    // Best effort
  }
}

/**
 * List all installed apps by scanning /var/lib/youeye/app-* directories.
 */
export async function listInstalledApps(): Promise<InstallMetadata[]> {
  const { readdir } = await import('fs/promises');
  const results: InstallMetadata[] = [];

  try {
    const entries = await readdir(BASE_DIR);
    for (const entry of entries) {
      if (entry.startsWith('app-')) {
        const appId = entry.slice(4); // Remove 'app-' prefix
        const meta = await readInstallMetadata(appId);
        if (meta) results.push(meta);
      }
    }
  } catch {
    // Directory may not exist yet
  }

  return results;
}
