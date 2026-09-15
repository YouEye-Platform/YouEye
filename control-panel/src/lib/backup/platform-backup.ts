import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { listInstalledApps } from '@/lib/market/metadata';
import { backupApp } from './app-backup';
import { backupCore } from './core-backup';
import { spineClient } from '@/lib/spine/client';
import type { BackupEventCallback } from './types';
import { BACKUP_ROOT } from './workspace';
import { readCurrentBackupSourceIdentity, type BackupSourceIdentity } from './compatibility';

const SETS_ROOT = path.join(BACKUP_ROOT, 'sets');
const LOCK_PATH = path.join(BACKUP_ROOT, '.operation.lock');
const RESTORE_STATUS_ROOT = path.join(BACKUP_ROOT, '.restore-status');
const BACKUP_ID = /^backup-\d{8}T\d{6}Z-[0-9a-f]{8}$/;
const RESTORE_OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface BackupSetRecord {
	schema: 'youeye.backup.set.v1';
  id: string;
  createdAt: string;
  completedAt?: string;
  status: 'creating' | 'completed' | 'failed';
	appCount: number;
	apps?: string[];
	mediaId?: string;
	reason?: 'manual' | 'scheduled' | 'pre-restore';
  sizeBytes?: number;
  verifiedAt?: string;
  source: BackupSourceIdentity;
  error?: string;
}

export interface CreatePlatformBackupOptions {
	passphrase?: unknown;
	useStoredPassphrase?: boolean;
	selectedAppIds?: string[];
	mediaId?: string;
	reason?: 'manual' | 'scheduled' | 'pre-restore';
}

export interface RestoreStatusRecord {
  schema: 'youeye.backup.restore-status.v1';
  operationId: string;
  backupId: string;
  status: 'running' | 'completed' | 'failed';
  message: string;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  error?: string;
}

export function validateBackupPassphrase(passphrase: unknown): string {
  if (typeof passphrase !== 'string' || passphrase.length < 12 || passphrase.length > 256) {
    throw new Error('Backup passphrase must contain 12 to 256 characters.');
  }
  return passphrase;
}

export function recoveryImportErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (/wrong password|no key found/i.test(message)) {
    return 'The recovery key is incorrect.';
  }
  return 'Could not read the selected recovery point.';
}

export function backupSetPath(id: string): string {
  if (!BACKUP_ID.test(id)) throw new Error('Invalid backup identifier.');
  return path.join(SETS_ROOT, id);
}

export function validateRestoreOperationId(value: unknown): string {
  if (typeof value !== 'string' || !RESTORE_OPERATION_ID.test(value)) {
    throw new Error('Invalid restore operation identifier.');
  }
  return value;
}

export async function writeRestoreStatus(record: RestoreStatusRecord): Promise<void> {
  validateRestoreOperationId(record.operationId);
  await mkdir(RESTORE_STATUS_ROOT, { recursive: true, mode: 0o700 });
  const destination = path.join(RESTORE_STATUS_ROOT, `${record.operationId}.json`);
  const temporary = `${destination}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  await (await import('node:fs/promises')).rename(temporary, destination);
}

export async function readRestoreStatus(operationId: string): Promise<RestoreStatusRecord | null> {
  validateRestoreOperationId(operationId);
  try {
    const record = JSON.parse(await readFile(path.join(RESTORE_STATUS_ROOT, `${operationId}.json`), 'utf8')) as RestoreStatusRecord;
    if (record.schema !== 'youeye.backup.restore-status.v1' || record.operationId !== operationId) return null;
    return record;
  } catch {
    return null;
  }
}

async function directorySize(root: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name);
    if (entry.isDirectory()) total += await directorySize(candidate);
    else if (entry.isFile()) total += (await stat(candidate)).size;
  }
  return total;
}

async function writeRecord(root: string, record: BackupSetRecord) {
  const destination = path.join(root, 'backup-set.json');
  const temporary = `${destination}.tmp`;
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  await (await import('node:fs/promises')).rename(temporary, destination);
}

async function acquireOperationLock(operation: string) {
  await mkdir(BACKUP_ROOT, { recursive: true, mode: 0o700 });
  let handle;
  try {
    handle = await open(LOCK_PATH, 'wx', 0o600);
  } catch {
    try {
      const existing = JSON.parse(await readFile(LOCK_PATH, 'utf8')) as { startedAt?: string };
      const started = Date.parse(existing.startedAt || '');
      if (!Number.isFinite(started) || Date.now() - started < 24 * 60 * 60 * 1000) {
        throw new Error('active');
      }
      await rm(LOCK_PATH, { force: true });
      handle = await open(LOCK_PATH, 'wx', 0o600);
    } catch {
      throw new Error('Another backup or restore operation is already running.');
    }
  }
  await handle.writeFile(`${JSON.stringify({ operation, pid: process.pid, startedAt: new Date().toISOString() })}\n`);
  return async () => {
    await handle.close().catch(() => undefined);
    await rm(LOCK_PATH, { force: true }).catch(() => undefined);
  };
}

export async function createPlatformBackup(input: unknown | CreatePlatformBackupOptions, onEvent: BackupEventCallback): Promise<BackupSetRecord> {
	const emit: BackupEventCallback = event => {
		try { onEvent(event); } catch { /* The backup must outlive a disconnected progress stream. */ }
	};
	const options: CreatePlatformBackupOptions = input && typeof input === 'object' && !Array.isArray(input)
		? input as CreatePlatformBackupOptions
		: { passphrase: input };
	const useStoredPassphrase = options.useStoredPassphrase === true;
	const passphrase = useStoredPassphrase ? undefined : validateBackupPassphrase(options.passphrase);
  const source = await readCurrentBackupSourceIdentity();
	const release = await acquireOperationLock('create');
  const createdAt = new Date();
  const id = `backup-${createdAt.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}-${randomBytes(4).toString('hex')}`;
  const root = backupSetPath(id);
	const record: BackupSetRecord = {
		schema: 'youeye.backup.set.v1', id, createdAt: createdAt.toISOString(), status: 'creating', appCount: 0,
		apps: [], mediaId: options.mediaId, reason: options.reason ?? 'manual', source,
  };
  await mkdir(root, { recursive: true, mode: 0o700 });
  await writeRecord(root, record);
  try {
    emit({ step: 0, totalSteps: 1, status: 'progress', stage: 'core', message: 'Backing up server configuration and accounts', progress: 1 });
		await backupCore({ targetPath: root, passphrase, useStoredPassphrase, sourceIdentity: source }, emit);

		const installedApps = await listInstalledApps();
		const installedByID = new Map(installedApps.map(app => [app.appId, app]));
		const selectedIDs = options.selectedAppIds ?? installedApps.map(app => app.appId);
		if (new Set(selectedIDs).size !== selectedIDs.length || selectedIDs.some(appID => !installedByID.has(appID))) {
			throw new Error('Backup selection contains an app that is not installed.');
		}
		const apps = selectedIDs.map(appID => installedByID.get(appID)!);
		record.appCount = apps.length;
		record.apps = selectedIDs;
		await writeRecord(root, record);
    for (let index = 0; index < apps.length; index++) {
      const app = apps[index];
      emit({
        step: index + 1,
        totalSteps: apps.length + 1,
        status: 'progress',
        stage: `app-${app.appId}`,
        message: `Backing up ${app.appId}`,
        progress: Math.round(((index + 1) / (apps.length + 1)) * 100),
      });
			await backupApp({ appId: app.appId, targetPath: root, passphrase, useStoredPassphrase, sourceIdentity: source }, emit);
		}

		record.status = 'completed';
		record.completedAt = new Date().toISOString();
		await writeRecord(root, record);
		record.sizeBytes = await directorySize(root);
		// Seal the inner manifest before restic reads the set. The external
		// catalog is only published after restic's repository check succeeds.
		await writeRecord(root, record);
		if (options.mediaId) {
			emit({ step: apps.length + 1, totalSteps: apps.length + 2, status: 'progress', stage: 'external-drive', message: 'Writing and verifying the encrypted recovery point', progress: 92 });
			await spineClient.storeBackupSet({
				media_id: options.mediaId,
				backup_id: record.id,
				passphrase,
				use_stored_passphrase: useStoredPassphrase,
				apps: selectedIDs,
				created_at: record.createdAt,
				size_bytes: record.sizeBytes,
				reason: record.reason ?? 'manual',
				source,
			});
			record.verifiedAt = new Date().toISOString();
			// The durable copy is now the checked external repository. Do not let
			// recurring backups silently consume YE-DATA with duplicate full sets.
			await rm(root, { recursive: true, force: true }).catch(() => undefined);
		}
		emit({ step: apps.length + 2, totalSteps: apps.length + 2, status: 'completed', stage: 'completed', message: 'Encrypted recovery point completed and verified', progress: 100 });
    return record;
  } catch (error) {
    record.status = 'failed';
    record.error = error instanceof Error ? error.message.slice(0, 500) : 'Backup failed';
    await writeRecord(root, record).catch(() => undefined);
		// An incomplete set is not a recovery point and cannot be resumed safely.
		// Keep the failure in operation status, but do not let repeated app errors
		// accumulate partial encrypted archives on YE-DATA.
		await rm(root, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  } finally {
    await release();
  }
}

export async function withRestoreLock<T>(operation: () => Promise<T>): Promise<T> {
  const release = await acquireOperationLock('restore');
  try {
    return await operation();
  } finally {
    await release();
  }
}
