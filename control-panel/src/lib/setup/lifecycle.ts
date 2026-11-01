import path from 'node:path';
import { constants, closeSync, fstatSync, openSync, readFileSync, writeFileSync, fsyncSync, renameSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { appUpdateJournalStore, withPlatformLifecycle } from '../market/update-admission';
import { AppUpdateExecutorLock } from '../market/update-executor-lock';
import { DEFAULT_DIRECTORY } from '../market/update-journal';
import { requireSetupReadiness } from './readiness';

type Marker = { schema: 'youeye.setup-lifecycle/1'; owner: string; kind: 'setup' | 'restore'; operation: string };
function readMarker(file: string): Marker | null {
  let fd: number;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.geteuid?.() || (stat.mode & 0o777) !== 0o600 || stat.size > 4096) throw new Error('Unsafe retained setup operation');
    const marker = JSON.parse(readFileSync(fd, 'utf8')) as Marker;
    if (marker.schema !== 'youeye.setup-lifecycle/1' || !['setup', 'restore'].includes(marker.kind)
      || typeof marker.owner !== 'string' || !marker.owner || marker.owner.length > 256
      || typeof marker.operation !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(marker.operation)) throw new Error('Invalid retained setup operation');
    return marker;
  } finally { closeSync(fd); }
}

/** Read-only completion evidence; an unsafe or unfinished marker never settles. */
export function hasRetainedSetupOperation(directory = process.env.YOUEYE_APP_UPDATE_JOURNAL_DIR ?? DEFAULT_DIRECTORY): boolean {
  if (!path.isAbsolute(directory)) throw new Error('Unsafe retained setup operation directory');
  return readMarker(path.join(directory, 'setup-operation.json')) !== null;
}
function syncDir(directory: string) {
  const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** Shared kernel admission is held through asynchronous effects and settlement.
 * The durable marker survives a crash and blocks native System checkpoints.
 * It contains operation identity only, never request payloads or secrets.
 */
export async function withSetupMutation<T>(owner: string, kind: Marker['kind'], operation: string,
  work: (settle: () => void) => Promise<T>,
  options: { directory?: string; readiness?: () => Promise<void> } = {},
): Promise<T> {
  const directory = appUpdateJournalStore(options.directory).directory;
  return withPlatformLifecycle(async () => {
    const lock = AppUpdateExecutorLock.acquire(path.join(directory, 'setup-operation.flock'));
    try {
    if (!owner || owner.length > 256 || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(operation)) throw new Error('Exact setup identity required');
    await (options.readiness ?? requireSetupReadiness)();
    const file = path.join(directory, 'setup-operation.json');
    const old = readMarker(file);
    if (old && (old.owner !== owner || old.kind !== kind || old.operation !== operation)) throw new Error('An unfinished setup operation must be resumed before another can start.');
    const marker: Marker = old ?? { schema: 'youeye.setup-lifecycle/1', owner, kind, operation };
    if (!old) {
      const tmp = path.join(directory, `.setup-${randomUUID()}.tmp`);
      const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(fd, JSON.stringify(marker)); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(tmp, file); syncDir(directory);
    }
    return await work(() => {
      const current = readMarker(file);
      if (!current || current.owner !== marker.owner || current.kind !== marker.kind || current.operation !== marker.operation) throw new Error('Retained setup operation changed before settlement');
      unlinkSync(file); syncDir(directory);
    });
    } finally { lock.release(); }
  }, directory);
}
