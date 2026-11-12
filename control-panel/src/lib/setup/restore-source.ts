import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, readFile, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { parseBackupSourceIdentity } from '../backup/compatibility';
import { SetupRestoreError } from './restore-recovery';

/** The native importer otherwise returns an existing cache even after reading
 * different bytes from the drive. Move that cache aside under backup admission
 * so the acknowledged response identifies a fresh, authenticated import.
 * On a lost response, preserve both inputs: that native request may still run.
 */
export async function importFreshSetupRestoreSource(options: {
  backupId: string;
  appIds: string[];
  expectedSource?: string;
  importBackup(): Promise<string>;
  root?: string;
}): Promise<{ backupPath: string; source: string }> {
  if (!/^backup-\d{8}T\d{6}Z-[0-9a-f]{8}$/.test(options.backupId)) throw new SetupRestoreError('source-mismatch');
  const root = await realpath(options.root ?? '/var/lib/youeye/backups');
  const expected = path.join(root, `import-${options.backupId}`);
  const previous = path.join(root, `.setup-import-${randomUUID()}`);
  let retainedPrevious = false;
  try {
    const info = await lstat(expected);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new SetupRestoreError('source-mismatch');
    await rename(expected, previous);
    retainedPrevious = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  let acknowledged = false;
  let ownedImport = false;
  try {
    const imported = await options.importBackup();
    acknowledged = true;
    if (await realpath(imported) !== expected || !(await lstat(expected)).isDirectory()) {
      throw new SetupRestoreError('source-mismatch');
    }
    ownedImport = true;
    const source = await fingerprintSetupRestoreSource(expected, options.backupId, options.appIds);
    if (options.expectedSource && source !== options.expectedSource) throw new SetupRestoreError('source-mismatch');
    if (retainedPrevious) await rm(previous, { recursive: true, force: true });
    return { backupPath: expected, source };
  } catch (error) {
    const rejected = error instanceof SetupRestoreError && error.code === 'import-failed';
    if (ownedImport) {
      await rm(expected, { recursive: true, force: true });
      if (retainedPrevious) await rename(previous, expected);
    } else if (rejected && retainedPrevious) {
      // An acknowledged native rejection has no unfinished import effects.
      await rename(previous, expected);
    } else if (acknowledged) {
      // An unexpected path is not authority to delete or move any output.
      throw new SetupRestoreError('operator-required');
    }
    throw error;
  }
}

/** Bound encrypted input, not a label or a pathname. Import/decrypt authentication
 * and the ordinary compatibility/admission checks remain mandatory on every run.
 */
export async function fingerprintSetupRestoreSource(root: string, backupId: string, appIds: string[]): Promise<string> {
  try {
    if (!/^backup-\d{8}T\d{6}Z-[0-9a-f]{8}$/.test(backupId)
      || appIds.some(id => !/^[a-z0-9][a-z0-9-]{0,62}$/.test(id))
      || new Set(appIds).size !== appIds.length) throw new Error();
    const rootInfo = await lstat(root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error();
    const metadata = path.join(root, 'backup-set.json');
    const metadataStat = await lstat(metadata);
    if (!metadataStat.isFile() || metadataStat.isSymbolicLink() || metadataStat.size > 1024 * 1024) throw new Error();
    const set = JSON.parse(await readFile(metadata, 'utf8'));
    if (set.schema !== 'youeye.backup.set.v1' || set.id !== backupId || set.status !== 'completed'
      || !Array.isArray(set.apps) || set.apps.some((id: unknown) => typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(id))
      || new Set(set.apps).size !== set.apps.length || appIds.some(id => !set.apps.includes(id))) throw new Error();
    parseBackupSourceIdentity(set.source);
    const files: string[] = ['backup-set.json'];
    let entries = 0;
    async function walk(relative: string, depth = 0) {
      if (++entries > 10000 || depth > 32) throw new Error();
      const directory = await lstat(path.join(root, relative));
      if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error();
      for (const name of (await readdir(path.join(root, relative))).sort()) {
        const child = path.posix.join(relative, name);
        const info = await lstat(path.join(root, child));
        if (info.isDirectory()) await walk(child, depth + 1);
        else if (info.isFile() && !info.isSymbolicLink()) {
          if (++entries > 10000) throw new Error();
          files.push(child);
        }
        else throw new Error();
      }
    }
    await walk('youeye/core');
    for (const appId of [...appIds].sort()) await walk(`youeye/apps/${appId}`);
    const digest = createHash('sha256').update('youeye.setup-restore.source/1\0');
    for (const relative of files.sort()) {
      const file = await open(path.join(root, relative), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const before = await file.stat();
        if (!before.isFile() || before.nlink !== 1) throw new Error();
        const hash = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024);
        let count = 0;
        while (true) {
          const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
          if (!bytesRead) break;
          count += bytesRead; hash.update(buffer.subarray(0, bytesRead));
        }
        const after = await file.stat();
        if (count !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
          || after.ctimeMs !== before.ctimeMs) throw new Error();
        digest.update(JSON.stringify([relative, count, hash.digest('hex')])).update('\n');
      } finally { await file.close(); }
    }
    return digest.digest('hex');
  } catch { throw new SetupRestoreError('source-mismatch'); }
}
