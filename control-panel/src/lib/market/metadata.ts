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

  if ((directoryStat.mode & 0o777) !== 0o700) {
    throw new Error(`Install metadata directory permissions are unsafe for ${appId}`);
  }
  return directory;
}

async function saveMetadataDocument(meta: InstallMetadata, filename: 'install.json' | 'retained.json'): Promise<void> {
  meta.schema = 'youeye.install.v1';
  meta.updatedAt = new Date().toISOString();
  const dir = metadataDir(meta.appId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await secureMetadataDirectory(meta.appId);
  const destination = path.join(dir, filename);
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

export async function saveInstallMetadata(meta: InstallMetadata): Promise<void> {
  await saveMetadataDocument(meta, 'install.json');
}

export async function saveRetainedInstallMetadata(meta: InstallMetadata): Promise<void> {
  await saveMetadataDocument(meta, 'retained.json');
}

async function readInstallMetadataFromBase(
  appId: string, baseDir: string, filename: 'install.json' | 'retained.json' = 'install.json',
): Promise<InstallMetadata | null> {
  try {
    await secureMetadataDirectory(appId, baseDir);
    const file = path.join(metadataDir(appId, baseDir), filename);
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    let data: string;
    try {
      const fileStat = await handle.stat();
      if (!fileStat.isFile()
        || fileStat.uid !== effectiveUid()
        || fileStat.size > 4 * 1024 * 1024
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

export async function readRetainedInstallMetadata(appId: string): Promise<InstallMetadata | null> {
  return readInstallMetadataFromBase(appId, BASE_DIR, 'retained.json');
}

export async function removeRetainedInstallMetadata(appId: string): Promise<void> {
  await secureMetadataDirectory(appId);
  await rm(path.join(metadataDir(appId), 'retained.json'), { force: true });
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
 * Scan /var/lib/youeye/app-* directories. A record that can't be read is returned by app id in `damaged`.
 */
async function scanMetadata(filename: 'install.json' | 'retained.json', baseDir = BASE_DIR):
  Promise<{ apps: InstallMetadata[]; damaged: string[] }> {
  const apps: InstallMetadata[] = [];
  const damaged: string[] = [];
  let entries: string[];
  try {
    entries = await readdir(baseDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { apps, damaged };
    throw error;
  }
  for (const entry of entries) {
    if (!entry.startsWith('app-')) continue;
    const appId = entry.slice(4);
    try {
      const meta = await readInstallMetadataFromBase(appId, baseDir, filename);
      if (meta) apps.push(meta);
    } catch {
      damaged.push(appId);
    }
  }
  return { apps, damaged };
}

async function listMetadata(filename: 'install.json' | 'retained.json'): Promise<InstallMetadata[]> {
  const { apps, damaged } = await scanMetadata(filename);
  if (damaged.length) throw new DamagedInstallMetadataError(damaged);
  return apps;
}

/** One or more install records can't be read; their apps' resources must be treated as owned. */
export class DamagedInstallMetadataError extends Error {
  constructor(readonly appIds: string[]) {
    super(`Install metadata for ${appIds.join(', ')} is corrupt or insecure`);
    this.name = 'DamagedInstallMetadataError';
  }
}

/**
 * Every install record, or a refusal naming the damaged ones. For ownership and destructive consumers (orphan
 * detection, container lifecycle, route removal, backup and restore): skipping a damaged record would make its app's
 * containers, volumes and routes look like nobody's.
 */
export async function listInstalledApps(): Promise<InstallMetadata[]> {
  return listMetadata('install.json');
}

/** Ownership consumers that can work around a damaged record: the readable apps plus the damaged app ids. */
export async function scanInstalledApps(): Promise<{ apps: InstallMetadata[]; damaged: string[] }> {
  const result = await scanMetadata('install.json');
  await reportDamagedInstallMetadata(result.damaged);
  return result;
}

/**
 * Read-only consumers (health probes, update checks, app lists): the readable apps. A damaged record is skipped and
 * raised as a health issue naming the app, so one broken file doesn't hide every other app.
 */
export async function listReadableInstalledApps(): Promise<InstallMetadata[]> {
  return (await scanInstalledApps()).apps;
}

export async function scanInstalledAppsAtBaseForTest(baseDir: string) {
  return scanMetadata('install.json', baseDir);
}

const damagedKey = Symbol.for('youeye.damaged-install-metadata');
const damagedGlobal = globalThis as typeof globalThis & { [damagedKey]?: Map<string, number> };
const reportedDamage = damagedGlobal[damagedKey] ??= new Map<string, number>();
const DAMAGE_REPORT_INTERVAL_MS = 10 * 60 * 1000;
let lastPersistedCheck = 0;

async function reportDamagedInstallMetadata(damaged: string[]): Promise<void> {
  try {
    const { observeIssue, resolveIssue } = await import('@/lib/health/issues');
    const now = Date.now();
    for (const appId of damaged) {
      if (now - (reportedDamage.get(appId) ?? 0) < DAMAGE_REPORT_INTERVAL_MS) continue;
      reportedDamage.set(appId, now);
      console.error(`[metadata] install record of ${appId} is corrupt or insecure (${path.join(metadataDir(appId), 'install.json')})`);
      await observeIssue({
        id: `app.${appId}.install-record`, severity: 'critical', source: 'market',
        title: `${appId}: install record is damaged`,
        body: `${path.join(metadataDir(appId), 'install.json')} can't be read (corrupt, or wrong owner or mode). Other apps keep working; ${appId}'s containers, storage and routes are left alone, and changes that need to know who owns them are refused until the record is fixed. If only its owner or mode changed, set them back (root, 0600); otherwise restore the app from a backup.`,
        fixable: false, debounce: 1,
      });
    }
    for (const appId of [...reportedDamage.keys()]) {
      if (damaged.includes(appId)) continue;
      reportedDamage.delete(appId);
      await resolveIssue(`app.${appId}.install-record`);
    }
    // An issue raised before a restart is not in this process's map: close it from the issue store once its record
    // reads again (or the app is gone). At most once a minute.
    if (now - lastPersistedCheck >= 60_000) {
      lastPersistedCheck = now;
      const { listIssues } = await import('@/lib/health/issues');
      for (const issue of await listIssues()) {
        const match = /^app\.([a-z0-9][a-z0-9-]*)\.install-record$/.exec(issue.id);
        if (match && !damaged.includes(match[1])) await resolveIssue(issue.id);
      }
    }
  } catch (error) {
    console.error('[metadata] could not report damaged install records:', error);
  }
}

export async function listRetainedApps(): Promise<InstallMetadata[]> {
  return listMetadata('retained.json');
}
