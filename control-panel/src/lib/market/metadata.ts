/**
 * Install metadata persistence for the Market.
 * Stores install config at /var/lib/youeye/app-{appId}/install.json
 */

import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'crypto';
import path from 'path';
import type { InstallMetadata } from './types';

const BASE_DIR = '/var/lib/youeye';

function metadataDir(appId: string, baseDir = BASE_DIR): string {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(appId)) throw new Error('Invalid app ID for install metadata');
  return path.join(baseDir, `app-${appId}`);
}

function metadataPath(appId: string, baseDir = BASE_DIR): string {
  return path.join(metadataDir(appId, baseDir), 'install.json');
}

function effectiveUid(): number {
  if (typeof process.geteuid !== 'function') {
    throw new Error('Install metadata requires POSIX ownership checks');
  }
  return process.geteuid();
}

async function secureMetadataDirectory(appId: string, baseDir = BASE_DIR): Promise<string> {
  const expectedUid = effectiveUid();
  const baseStat = await lstat(baseDir);
  if (!baseStat.isDirectory()
    || baseStat.uid !== expectedUid
    || (baseStat.mode & 0o022) !== 0) {
    throw new Error(`Install metadata base directory is unsafe for ${appId}`);
  }

  const directory = metadataDir(appId, baseDir);
  const directoryStat = await lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.uid !== expectedUid) {
    throw new Error(`Install metadata directory is unsafe for ${appId}`);
  }

  const directoryMode = directoryStat.mode & 0o777;
  if (directoryMode === 0o700) return directory;
  if (directoryMode !== 0o777) {
    throw new Error(`Install metadata directory permissions are unsafe for ${appId}`);
  }

  // Images predating private Market metadata created these root-owned
  // directories as 0777. Tighten only that exact legacy shape before opening
  // the metadata file; unfamiliar permissions still fail closed.
  await chmod(directory, 0o700);
  const repairedStat = await lstat(directory);
  if (!repairedStat.isDirectory()
    || repairedStat.uid !== expectedUid
    || repairedStat.dev !== directoryStat.dev
    || repairedStat.ino !== directoryStat.ino
    || (repairedStat.mode & 0o777) !== 0o700) {
    throw new Error(`Install metadata directory repair failed for ${appId}`);
  }
  return directory;
}

export async function saveInstallMetadata(meta: InstallMetadata): Promise<void> {
  const dir = metadataDir(meta.appId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await secureMetadataDirectory(meta.appId);
  const destination = metadataPath(meta.appId);
  const temporary = path.join(dir, `.install-${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(meta, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, destination);
    await chmod(destination, 0o600);
    const directoryHandle = await open(dir, 'r');
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function readInstallMetadataFromBase(appId: string, baseDir: string): Promise<InstallMetadata | null> {
  try {
    await secureMetadataDirectory(appId, baseDir);
    const file = metadataPath(appId, baseDir);
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    let data: string;
    try {
      const fileStat = await handle.stat();
      if (!fileStat.isFile()
        || fileStat.uid !== effectiveUid()
        || (fileStat.mode & 0o777) !== 0o600) {
        throw new Error(`Install metadata permissions are unsafe for ${appId}`);
      }
      data = await handle.readFile('utf8');
    } finally {
      await handle.close();
    }
    if (!data) {
      throw new Error(`Install metadata permissions are unsafe for ${appId}`);
    }
    const parsed = JSON.parse(data) as InstallMetadata;
    if (!parsed || parsed.appId !== appId || !Array.isArray(parsed.containers)) {
      throw new Error(`Install metadata is invalid for ${appId}`);
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`Install metadata for ${appId} is corrupt or insecure`);
  }
}

export async function readInstallMetadata(appId: string): Promise<InstallMetadata | null> {
  return readInstallMetadataFromBase(appId, BASE_DIR);
}

// Direct export for isolated filesystem regression coverage. Production
// callers use readInstallMetadata() and cannot redirect the durable state root.
export async function readInstallMetadataAtBaseForTest(
  appId: string,
  baseDir: string,
): Promise<InstallMetadata | null> {
  return readInstallMetadataFromBase(appId, baseDir);
}

export async function removeInstallMetadata(appId: string): Promise<void> {
  const directory = metadataDir(appId);
  await rm(directory, { recursive: true, force: true });
  try {
    await stat(directory);
    throw new Error(`Install metadata directory remains for ${appId}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function removeInstallMetadataRecordFromBase(appId: string, baseDir: string): Promise<void> {
  try {
    await secureMetadataDirectory(appId, baseDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }

  const file = metadataPath(appId, baseDir);
  await rm(file, { force: true });
  try {
    await lstat(file);
    throw new Error(`Install metadata record remains for ${appId}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/**
 * Remove only the durable lifecycle record while preserving the app-owned
 * directory. Restore-mode rollback and keep-data uninstall both need this:
 * secrets and volume data share /var/lib/youeye/app-{appId} with install.json.
 */
export async function removeInstallMetadataRecord(appId: string): Promise<void> {
  await removeInstallMetadataRecordFromBase(appId, BASE_DIR);
}

// Direct export for isolated filesystem regression coverage. Production
// callers cannot redirect the durable state root.
export async function removeInstallMetadataRecordAtBaseForTest(
  appId: string,
  baseDir: string,
): Promise<void> {
  await removeInstallMetadataRecordFromBase(appId, baseDir);
}

/**
 * List all installed apps by scanning /var/lib/youeye/app-* directories.
 */
export async function listInstalledApps(): Promise<InstallMetadata[]> {
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
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  return results;
}
