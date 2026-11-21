import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { listInstalledApps } from '@/lib/market/metadata';
import { backupApp } from './app-backup';
import { backupCore } from './core-backup';
import { SpineAPIError, SpineTransportError, spineClient } from '@/lib/spine/client';
import type { BackupEncryption, BackupEventCallback } from './types';
import { BACKUP_ROOT } from './workspace';
import { readCurrentBackupSourceIdentity, type BackupSourceIdentity } from './compatibility';
import { AppUpdateExecutorLock } from '@/lib/market/update-executor-lock';

const SETS_ROOT = path.join(BACKUP_ROOT, 'sets');
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
	/** Installed apps this set does not contain, with the reason (an unfinished update). A full restore from this set
	 * refuses while they are installed, so it never removes them. */
	skippedApps?: Array<{ appId: string; reason: string }>;
	mediaId?: string;
	reason?: 'manual' | 'scheduled' | 'pre-restore';
  sizeBytes?: number;
  verifiedAt?: string;
  source: BackupSourceIdentity;
  /** How Spine encrypted every archive of the set; a restore passes it back. Absent in sets made before 0.6.15. */
  encryption?: BackupEncryption;
  error?: string;
}

/** The archives of one set are encrypted alike; a set that is not cannot be restored with one record. */
function sameEncryption(a: BackupEncryption | undefined, b: BackupEncryption | undefined): boolean {
  return a?.cipher === b?.cipher && a?.kdf === b?.kdf && a?.digest === b?.digest && a?.iterations === b?.iterations
    && a?.mac === b?.mac;
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

export async function readRestoreStatus(operationId: string, options: { strict?: boolean } = {}): Promise<RestoreStatusRecord | null> {
  validateRestoreOperationId(operationId);
  try {
    const filename = path.join(RESTORE_STATUS_ROOT, `${operationId}.json`);
    let text: string;
    if (options.strict) {
      const directory = await lstat(RESTORE_STATUS_ROOT);
      if (!directory.isDirectory() || directory.uid !== process.geteuid?.() || (directory.mode & 0o777) !== 0o700) {
        throw new Error('Restore status is unavailable');
      }
      const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const info = await file.stat();
        if (!info.isFile() || info.uid !== process.geteuid?.() || (info.mode & 0o777) !== 0o600
          || info.nlink !== 1 || info.size < 1 || info.size > 1024 * 1024) throw new Error('Restore status is unavailable');
        text = await file.readFile('utf8');
      } finally { await file.close(); }
    } else {
      text = await readFile(filename, 'utf8');
    }
    const record = JSON.parse(text) as RestoreStatusRecord;
    if (record.schema !== 'youeye.backup.restore-status.v1' || record.operationId !== operationId
      || !BACKUP_ID.test(record.backupId) || !['running', 'completed', 'failed'].includes(record.status)
      || typeof record.message !== 'string') throw new Error('Restore status is unavailable');
    return record;
  } catch (error) {
    if (options.strict && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
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

/**
 * The backup operation lock, held for a whole backup set or restore. Spine's Control Panel restart waits for it
 * (spine/internal/api/control_restart.go): a set takes the lifecycle lock only per archive, so a System update can
 * run between two archives, but a restart there would leave the set "creating".
 */
async function acquireOperationLock(directory = BACKUP_ROOT) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // A kernel lease, released automatically on process loss.
  const lock = AppUpdateExecutorLock.acquire(path.join(directory, '.operation.flock'));
  return async () => { lock.release(); };
}

/** The body of Spine's `POST /api/backup/repository/store` (contract: `contracts/spine-cp/backup-store-request.json`). */
export function backupStoreRequest(record: BackupSetRecord, mediaId: string, passphrase: string | undefined, useStoredPassphrase: boolean) {
	return {
		media_id: mediaId,
		backup_id: record.id,
		passphrase,
		use_stored_passphrase: useStoredPassphrase,
		apps: record.apps ?? [],
		created_at: record.createdAt,
		size_bytes: record.sizeBytes ?? 0,
		reason: record.reason ?? 'manual',
		// Spine (same build) stores the whole identity, release keys included.
		source: record.source,
	};
}

/** The source fields a 0.6.11 Spine knows (it decodes the store request strictly). */
const OLD_SOURCE_FIELDS = ['schema', 'runtime_kind', 'image_version', 'source_tree', 'state_schema_version', 'data_schema_version',
  'disk_layout_version', 'spine_version', 'control_panel_version', 'ui_version', 'pointer_version'] as const;

type BackupStoreRequest = ReturnType<typeof backupStoreRequest>;

/**
 * Store a backup set through Spine. Spine normally ships with this Control
 * Panel, but after booting the other slot from the boot menu a 0.6.11 Spine
 * can run beside it: it refuses the release keys with 400 "invalid repository
 * store request" (its strict decoder does not name the field). Then the
 * request is sent once more with only the fields it knows.
 */
export async function storeBackupSet(request: BackupStoreRequest,
  store: (request: BackupStoreRequest) => Promise<unknown> = body => spineClient.storeBackupSet(body)): Promise<void> {
  try {
    await store(request);
  } catch (error) {
    const refusedShape = error instanceof SpineAPIError && error.statusCode === 400
      && /invalid repository store request|unknown field/i.test(error.message);
    const source = request.source as unknown as Record<string, unknown>;
    if (!refusedShape || !Object.keys(source).some(field => !(OLD_SOURCE_FIELDS as readonly string[]).includes(field))) throw error;
    const older = Object.fromEntries(OLD_SOURCE_FIELDS.filter(field => source[field] !== undefined).map(field => [field, source[field]]));
    await store({ ...request, source: older as unknown as BackupSourceIdentity });
  }
}

/**
 * After a restore and its rollback have both failed: put the pre-restore backup on the backup drive, where the
 * restore page lists it as a recovery point and it can be restored like any other. On the box it
 * can only be read by hand. The local copy goes once the drive's copy is written and checked; when the drive
 * cannot take it, the local copy stays. Returns where the backup is, for the message to the owner.
 */
export async function preservePreRestoreBackup(
  record: BackupSetRecord,
  mediaId: string,
  passphrase: string,
  store: (request: BackupStoreRequest) => Promise<unknown> = body => spineClient.storeBackupSet(body),
  remove: (root: string) => Promise<void> = root => rm(root, { recursive: true, force: true }),
): Promise<string> {
  const root = backupSetPath(record.id);
  try {
    await storeBackupSet(backupStoreRequest(record, mediaId, passphrase, false), store);
  } catch {
    return `kept on the server in ${root}`;
  }
  await remove(root).catch(() => undefined);
  return `saved on the backup drive as recovery point ${record.id}, made just before the restore`;
}

/**
 * A set being written to the backup drive has `<id>.storing` beside it, from just before the store until its local
 * copy is deleted. Its own record already says "completed" (restic reads it), so the marker is what tells a set
 * whose store a killed Control Panel never finished from a real local recovery point (a set made without a drive, or
 * a pre-restore backup the drive could not take).
 */
function storingMarker(id: string): string {
  return `${backupSetPath(id)}.storing`;
}

/**
 * Delete the sets a backup left "creating" when its process ended midway (a power cut, a killed Control Panel). Only
 * the holder of the backup operation lock writes sets, so under it none is a backup in progress, and a "creating"
 * set is never a recovery point.
 *
 * A set left "storing" is different: it is complete, and when its store to the drive never finished it is the only
 * complete copy of that backup. It stays until a newer set that holds what it holds is safe
 * (`removeSupersededStoringSets`). Of several, one that a newer one of them covers goes here: it is superseded
 * already, and each is a whole backup on Data.
 */
async function removeAbandonedSets(): Promise<void> {
  let names: string[];
  try { names = await readdir(SETS_ROOT); } catch { return; }
  const storing = abandonedStoringSets(names);
  const held = new Map<string, readonly string[] | null>();
  for (const id of storing) held.set(id, await storedSetApps(id));
  for (const [index, id] of storing.entries()) {
    const apps = held.get(id) ?? null;
    if (apps === UNREADABLE_SET) continue; // says nothing: kept, and it covers no other set either
    const newer = storing.slice(index + 1).map(other => held.get(other) ?? null).filter(other => other !== UNREADABLE_SET);
    if (apps === null || newer.some(other => other !== null && coversApps(other, apps))) await removeLocalCopy(id);
  }
  for (const name of names) {
    if (!BACKUP_ID.test(name)) continue;
    const root = path.join(SETS_ROOT, name);
    try {
      const record = JSON.parse(await readFile(path.join(root, 'backup-set.json'), 'utf8')) as { status?: unknown };
      if (record.status !== 'creating') continue;
    } catch { continue; }
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** The IDs with a storing marker, oldest first (an ID starts with its creation time). */
function abandonedStoringSets(names: string[]): string[] {
  return names.map(name => name.match(/^(.+)\.storing$/)?.[1]).filter((id): id is string => !!id && BACKUP_ID.test(id)).sort();
}

/**
 * The apps a set left "storing" holds (every set holds the core). Null: there is no set (only its marker is left),
 * or its record is not one or does not say "completed". That is not a recovery point, and nothing can restore from
 * it. A record that is there and cannot be read just now says nothing: such a set is kept (UNREADABLE_SET is held
 * by no set).
 */
const UNREADABLE_SET: readonly string[] = ['\0unreadable'];
async function storedSetApps(id: string): Promise<readonly string[] | null> {
  let raw: string;
  try { raw = await readFile(path.join(backupSetPath(id), 'backup-set.json'), 'utf8'); } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? null : UNREADABLE_SET;
  }
  try {
    const record = JSON.parse(raw) as { status?: unknown; apps?: unknown };
    if (record.status !== 'completed') return null;
    return Array.isArray(record.apps) ? record.apps.filter((app): app is string => typeof app === 'string') : [];
  } catch { return null; }
}

function coversApps(apps: readonly string[], held: readonly string[]): boolean {
  return held.every(app => apps.includes(app));
}

/**
 * Once a new set is safe (written, and stored on the drive when it was made for one): delete the sets an earlier
 * backup left "storing" that it supersedes. Until 0.6.15 the next backup deleted them before it wrote anything, so
 * a backup that then failed left the box with no complete copy at all. A backup that fails keeps them.
 *
 * The new set supersedes one only when it holds what that one holds: every set holds the core, so that is each of
 * its apps. A set of fewer apps (a scheduled backup takes the apps that are due, a manual one a selection, and an
 * app with an unfinished update is skipped) deleted a kept full set and with it the only complete copy of the apps
 * it left out. An app that is not installed any more (`installed`) does not count: no later set can hold it, and
 * the set would stay on Data for ever.
 */
async function removeSupersededStoringSets(newId: string, apps: readonly string[], installed: readonly string[]): Promise<void> {
  let names: string[];
  try { names = await readdir(SETS_ROOT); } catch { return; }
  for (const id of abandonedStoringSets(names)) {
    if (id === newId) continue;
    const held = await storedSetApps(id);
    if (held === null || coversApps(apps, held === UNREADABLE_SET ? held : held.filter(app => installed.includes(app)))) await removeLocalCopy(id);
  }
}

/** Delete a set's local copy, then its storing marker (kept when the copy could not go, so the next backup retries). */
async function removeLocalCopy(id: string): Promise<void> {
  const removed = await rm(backupSetPath(id), { recursive: true, force: true }).then(() => true, () => false);
  if (removed) await rm(storingMarker(id), { force: true }).catch(() => undefined);
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
	const release = await acquireOperationLock();
	await removeAbandonedSets(); // never throws
  const createdAt = new Date();
  const id = `backup-${createdAt.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}-${randomBytes(4).toString('hex')}`;
  const root = backupSetPath(id);
	const record: BackupSetRecord = {
		schema: 'youeye.backup.set.v1', id, createdAt: createdAt.toISOString(), status: 'creating', appCount: 0,
		apps: [], mediaId: options.mediaId, reason: options.reason ?? 'manual', source,
  };
  await mkdir(root, { recursive: true, mode: 0o700 });
  await writeRecord(root, record);
  let storing = false;
  try {
    emit({ step: 0, totalSteps: 1, status: 'progress', stage: 'core', message: 'Backing up server configuration and accounts', progress: 1 });
		record.encryption = await backupCore({ targetPath: root, passphrase, useStoredPassphrase, sourceIdentity: source }, emit);

		const installedApps = await listInstalledApps();
		const installedByID = new Map(installedApps.map(app => [app.appId, app]));
		const selectedIDs = options.selectedAppIds ?? installedApps.map(app => app.appId);
		if (new Set(selectedIDs).size !== selectedIDs.length || selectedIDs.some(appID => !installedByID.has(appID))) {
			throw new Error('Backup selection contains an app that is not installed.');
		}
		// An app whose update is unfinished can't be backed up (its lock refuses until recovery); skip it, say so, and
		// keep backing up the rest instead of failing the whole set.
		const { isAppUpdateReserved } = await import('@/lib/market/update-admission');
		const skipped = selectedIDs.filter(appID => isAppUpdateReserved(appID));
		if (skipped.length) {
			record.skippedApps = skipped.map(appId => ({ appId, reason: 'unfinished app update (run youeye app recover)' }));
			emit({ step: 0, totalSteps: 1, status: 'progress', stage: 'core',
				message: `Skipping ${skipped.join(', ')}: an app update is unfinished`, progress: 1 });
		}
		const apps = selectedIDs.filter(appID => !skipped.includes(appID)).map(appID => installedByID.get(appID)!);
		record.appCount = apps.length;
		record.apps = apps.map(app => app.appId);
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
			const encryption = await backupApp({ appId: app.appId, targetPath: root, passphrase, useStoredPassphrase, sourceIdentity: source }, emit);
			if (!sameEncryption(record.encryption, encryption)) throw new Error('Spine changed the backup encryption within one backup set.');
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
			await writeFile(storingMarker(id), '', { mode: 0o600 });
			storing = true;
			await storeBackupSet(backupStoreRequest(record, options.mediaId, passphrase, useStoredPassphrase));
			storing = false;
			record.verifiedAt = new Date().toISOString();
			// The durable copy is now the checked external repository. Do not let
			// recurring backups silently consume YE-DATA with duplicate full sets.
			await removeLocalCopy(id);
		}
		// This set is safe now: what an earlier backup left half-stored is superseded, when this set holds it.
		await removeSupersededStoringSets(id, record.apps, installedApps.map(app => app.appId)); // never throws
		emit({ step: apps.length + 2, totalSteps: apps.length + 2, status: 'completed', stage: 'completed', message: 'Encrypted recovery point completed and verified', progress: 100 });
    return record;
  } catch (error) {
		// The store ended without Spine's answer: Spine restarted under it (a System update can be admitted during a
		// store, which holds only the backup operation lock), its socket was not there or refused at that moment, or
		// it did not answer within the step's limit. Spine did not refuse the set, and the set is complete
		// and its only copy: it stays as a set left "storing" (marker and "completed" record), exactly as after a
		// killed Control Panel, until a later set that holds what it holds is safe. The backup still fails.
		if (storing && error instanceof SpineTransportError) throw error;
    record.status = 'failed';
    record.error = error instanceof Error ? error.message.slice(0, 500) : 'Backup failed';
    await writeRecord(root, record).catch(() => undefined);
		// An incomplete set is not a recovery point and cannot be resumed safely.
		// Keep the failure in operation status, but do not let repeated app errors
		// accumulate partial encrypted archives on YE-DATA.
		await removeLocalCopy(id);
    throw error;
  } finally {
    await release();
  }
}

export async function withRestoreLock<T>(operation: () => Promise<T>, directory = BACKUP_ROOT): Promise<T> {
  const release = await acquireOperationLock(directory);
  try {
    return await operation();
  } finally {
    await release();
  }
}
