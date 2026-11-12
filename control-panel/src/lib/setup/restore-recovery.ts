import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { SetupRestoreCheckpoint } from '../backup/types';
import { AppUpdateExecutorLock } from '../market/update-executor-lock';

const OPERATION = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const APP = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SCHEMA = 'youeye.setup-restore/1';

export class SetupRestoreError extends Error {
  constructor(public readonly code: 'identity-mismatch' | 'resume-required' | 'operation-missing'
    | 'operation-active' | 'operator-required' | 'import-failed' | 'source-mismatch' | 'restore-failed' | 'state-unavailable') {
    super(code);
  }
}

/** No recovery key, archive path, credentials, or raw exception is stored here. */
export interface SetupRestoreIdentity {
  operationId: string;
  ownerId: string;
  sessionId: string;
  mediaId: string;
  backupId: string;
  appIds: string[];
  target: string;
}
type Step = { state: 'started' | 'completed'; retry: 'replace' | 'never' };
export interface SetupRestoreRecord {
  schema: typeof SCHEMA;
  identity: SetupRestoreIdentity;
  source?: string;
  phase: 'prepared' | 'restoring' | 'restored' | 'finalizing' | 'completed';
  status: 'running' | 'failed' | 'completed';
  steps: Record<string, Step>;
  quiesced: string[];
  restart: 'pending' | 'requested' | 'acknowledged';
  operatorRequired?: boolean;
  startedAt: string;
  updatedAt: string;
}

function validIdentity(value: SetupRestoreIdentity): boolean {
  return !!value && OPERATION.test(value.operationId)
    && [value.ownerId, value.sessionId, value.mediaId, value.backupId]
      .every(item => typeof item === 'string' && item.length > 0 && item.length <= 256)
    && typeof value.target === 'string' && DIGEST.test(value.target)
    && /^backup-\d{8}T\d{6}Z-[0-9a-f]{8}$/.test(value.backupId)
    && Array.isArray(value.appIds) && value.appIds.length <= 1000
    && value.appIds.every(item => typeof item === 'string' && APP.test(item))
    && new Set(value.appIds).size === value.appIds.length;
}
export function assertSameSetupRestore(a: SetupRestoreIdentity, b: SetupRestoreIdentity): void {
  if (!validIdentity(a) || !validIdentity(b)
    || ['operationId', 'ownerId', 'sessionId', 'mediaId', 'backupId', 'target']
      .some(key => a[key as keyof SetupRestoreIdentity] !== b[key as keyof SetupRestoreIdentity])
    || JSON.stringify([...a.appIds].sort()) !== JSON.stringify([...b.appIds].sort())) {
    throw new SetupRestoreError('identity-mismatch');
  }
}

/** Atomic, fsynced records outside every volume that fullRestore can replace.
 * The existing setup kernel lock serializes writers; readers see an entire revision.
 * Missing is distinct from unreadable/corrupt: damaged evidence never starts new work.
 */
export class SetupRestoreStore {
  constructor(readonly directory = '/var/lib/youeye/backups/.setup-restore') {}
  private filename(id: string) {
    if (!OPERATION.test(id)) throw new SetupRestoreError('identity-mismatch');
    return path.join(this.directory, `${id}.json`);
  }
  private async checkDirectory() {
    const created = await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.directory);
    if (!info.isDirectory() || info.uid !== process.geteuid?.() || (info.mode & 0o777) !== 0o700) {
      throw new SetupRestoreError('state-unavailable');
    }
    if (created) {
      const parent = await open(path.dirname(this.directory), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await parent.sync(); } finally { await parent.close(); }
    }
  }
  private async syncDirectory() {
    const dir = await open(this.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await dir.sync(); } finally { await dir.close(); }
  }
  private async acquireRun(id: string): Promise<AppUpdateExecutorLock> {
    this.filename(id);
    await this.checkDirectory();
    try { return AppUpdateExecutorLock.acquire(path.join(this.directory, `${id}.flock`)); }
    catch (error) {
      if (error instanceof Error && error.message === 'App update executor lock is busy') {
        throw new SetupRestoreError('operation-active');
      }
      throw new SetupRestoreError('state-unavailable');
    }
  }
  /** A process death releases this lease, without discarding recovery evidence. */
  async withRunLock<T>(id: string, work: () => Promise<T>): Promise<T> {
    const lock = await this.acquireRun(id);
    try { return await work(); } finally { lock.release(); }
  }
  /** Hold a free lease through the read so an inactive result is a coherent snapshot. */
  async readStatus(id: string) {
    // Early status polling must not acquire the writer's lease before its first
    // receipt exists: a harmless missing-status read could otherwise reject
    // the original submission after it has retained the setup marker.
    if (!(await this.read(id))) return null;
    let lock: AppUpdateExecutorLock | undefined;
    let active = false;
    try { lock = await this.acquireRun(id); }
    catch (error) {
      if (!(error instanceof SetupRestoreError) || error.code !== 'operation-active') throw error;
      active = true;
    }
    try {
      const record = await this.read(id);
      return record ? { record, status: setupRestoreStatus(record, active) } : null;
    } finally { lock?.release(); }
  }
  async read(id: string): Promise<SetupRestoreRecord | null> {
    const filename = this.filename(id);
    try {
      await this.checkDirectory();
      let file;
      try { file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
      try {
        const info = await file.stat();
        if (!info.isFile() || info.uid !== process.geteuid?.() || (info.mode & 0o777) !== 0o600
          || info.nlink !== 1 || info.size < 1 || info.size > 1024 * 1024) throw new Error();
        const record = JSON.parse(await file.readFile('utf8')) as SetupRestoreRecord;
        if (record.schema !== SCHEMA || !validIdentity(record.identity) || record.identity.operationId !== id
          || (record.source !== undefined && (typeof record.source !== 'string' || !DIGEST.test(record.source)))
          || !['prepared', 'restoring', 'restored', 'finalizing', 'completed'].includes(record.phase)
          || !['running', 'failed', 'completed'].includes(record.status)
          || !['pending', 'requested', 'acknowledged'].includes(record.restart)
          || (record.operatorRequired !== undefined && typeof record.operatorRequired !== 'boolean')
          || !record.steps || typeof record.steps !== 'object' || Array.isArray(record.steps)
          || Object.entries(record.steps).some(([name, step]) => !/^[a-z][a-z0-9:-]{0,127}$/.test(name)
            || !step || !['started', 'completed'].includes(step.state) || !['replace', 'never'].includes(step.retry))
          || !Array.isArray(record.quiesced) || record.quiesced.some(name => typeof name !== 'string' || !APP.test(name))
          || !Number.isFinite(Date.parse(record.startedAt)) || !Number.isFinite(Date.parse(record.updatedAt))
          || (record.phase !== 'prepared' && !record.source)
          || (record.phase === 'prepared' && Object.keys(record.steps).some(name => name !== 'source-import'))
          || (['restored', 'finalizing', 'completed'].includes(record.phase)
            && Object.values(record.steps).some(step => step.state !== 'completed'))
          || (record.phase !== 'completed' && record.status === 'completed')
          || (record.phase === 'completed' && record.operatorRequired)
          || (!['finalizing', 'completed'].includes(record.phase) && record.restart !== 'pending')
          || (record.phase === 'completed' && (record.status !== 'completed' || record.restart !== 'acknowledged'))) {
          throw new Error();
        }
        return record;
      } finally { await file.close(); }
    } catch { throw new SetupRestoreError('state-unavailable'); }
  }
  async write(record: SetupRestoreRecord): Promise<void> {
    await this.checkDirectory();
    const destination = this.filename(record.identity.operationId);
    const temporary = path.join(this.directory, `.${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        await file.writeFile(`${JSON.stringify(record)}\n`);
        await file.sync();
      } finally { await file.close(); }
      await rename(temporary, destination);
      await this.syncDirectory();
    } finally { await unlink(temporary).catch(() => undefined); }
  }
}

export function setupRestoreStatus(record: SetupRestoreRecord, active = false) {
  const uncertain = record.operatorRequired === true || record.restart === 'requested'
    || Object.values(record.steps).some(step => step.state === 'started' && step.retry === 'never');
  const completed = record.phase === 'completed';
  const messageCode = completed ? 'restore-completed'
    : active ? 'restore-running' : uncertain ? 'restore-needs-reconciliation' : 'restore-can-resume';
  return {
    operationId: record.identity.operationId, status: completed ? 'completed' : active ? 'running' : 'failed',
    mediaId: record.identity.mediaId, backupId: record.identity.backupId, appIds: [...record.identity.appIds],
    phase: record.phase, active,
    recovery: completed || active ? 'none' : uncertain ? 'operator-required'
      : ['restored', 'finalizing'].includes(record.phase) ? 'finalize' : 'resume',
    // UI translates this stable code; no untrusted exception or backup content.
    messageCode,
    message: completed ? 'Restore complete. Sign in with a restored account.'
      : active ? 'Restoring your platform…' : uncertain ? 'Restore needs operator reconciliation before continuing.'
      : 'The original restore can be resumed.',
  } as const;
}

export interface SetupRestoreIO {
  store: Pick<SetupRestoreStore, 'read' | 'write' | 'withRunLock'>;
  /** Authenticated import + fingerprint of the exact complete selected archive set.
   * import-failed/source-mismatch prove the native request finished.
   * Any other rejection may leave an import running and requires an operator.
   */
  importSource(expectedSource?: string): Promise<string>;
  restore(checkpoint: SetupRestoreCheckpoint): Promise<void>;
  setupCompleted(): Promise<boolean>;
  completeSetup(): Promise<void>;
  restartControl(): Promise<void>;
  /** Called only after the durable completed result, while admission is still held. */
  settle(): void;
}

/** Caller holds both withSetupMutation and withRestoreLock for the entire call.
 * Resume is an explicit exact-operation request. Completed steps are not replayed;
 * only source-replacement steps may be reset after a partial/unknown attempt.
 */
export async function runSetupRestore(
  identity: SetupRestoreIdentity, action: 'start' | 'resume', io: SetupRestoreIO,
): Promise<SetupRestoreRecord> {
  if (!validIdentity(identity)) throw new SetupRestoreError('identity-mismatch');
  return io.store.withRunLock(identity.operationId, () => runUnderLock(identity, action, io));
}

async function runUnderLock(
  identity: SetupRestoreIdentity, action: 'start' | 'resume', io: SetupRestoreIO,
): Promise<SetupRestoreRecord> {
  let record = await io.store.read(identity.operationId);
  if (record) {
    assertSameSetupRestore(record.identity, identity);
    if (action !== 'resume') throw new SetupRestoreError('resume-required');
  } else {
    if (action !== 'start') throw new SetupRestoreError('operation-missing');
    if (await io.setupCompleted()) throw new SetupRestoreError('identity-mismatch');
    const now = new Date().toISOString();
    record = { schema: SCHEMA, identity: { ...identity, appIds: [...identity.appIds].sort() },
      phase: 'prepared', status: 'running', steps: {}, quiesced: [], restart: 'pending', startedAt: now, updatedAt: now };
    await io.store.write(record);
  }
  const state = record;
  const save = async () => {
    state.updatedAt = new Date().toISOString();
    await io.store.write(state);
  };
  if (state.phase === 'completed') { io.settle(); return state; }
  if (setupRestoreStatus(state).recovery === 'operator-required') throw new SetupRestoreError('operator-required');

  try {
    state.status = 'running';
    await save();
    if (!['restored', 'finalizing'].includes(state.phase)) {
      // Re-authenticate the original external media on recovery. Never substitute
      // a cached path, a different selection, or a new source with the same label.
      // Native import can outlive a lost HTTP response. Retain its intent too:
      // only an acknowledged rejection may retry against the shared cache.
      state.steps['source-import'] = { state: 'started', retry: 'never' };
      await save();
      let source: string;
      try { source = await io.importSource(state.source); }
      catch (error) {
        if (error instanceof SetupRestoreError && ['import-failed', 'source-mismatch'].includes(error.code)) {
          state.steps['source-import'] = { state: 'completed', retry: 'never' };
        }
        throw error;
      }
      state.steps['source-import'] = { state: 'completed', retry: 'never' };
      if (!DIGEST.test(source)) throw new SetupRestoreError('source-mismatch');
      if (state.source && state.source !== source) throw new SetupRestoreError('source-mismatch');
      state.source = source;
      state.phase = 'restoring';
      await save();
      const checkpoint: SetupRestoreCheckpoint = {
        completed: name => state.steps[name]?.state === 'completed',
        step: async (name, retry, work) => {
          if (!/^[a-z][a-z0-9:-]{0,127}$/.test(name) || !['replace', 'never'].includes(retry)) {
            throw new SetupRestoreError('state-unavailable');
          }
          const previous = state.steps[name];
          if (previous && previous.retry !== retry) throw new SetupRestoreError('operator-required');
          if (previous?.state === 'completed') return;
          if (previous && retry === 'never') throw new SetupRestoreError('operator-required');
          state.steps[name] = { state: 'started', retry };
          // Intent and the bound source are on disk BEFORE the first live effect.
          await save();
          await work();
          state.steps[name] = { state: 'completed', retry };
          await save();
        },
        rememberQuiesced: async names => {
          if (names.some(name => !APP.test(name))) throw new SetupRestoreError('state-unavailable');
          state.quiesced = [...new Set(names)].sort();
          await save();
        },
        quiesced: () => [...state.quiesced],
      };
      await io.restore(checkpoint);
      state.phase = 'restored';
      await save();
    }
    // The source restore is durably complete. Neither finalization retries nor
    // an SSE response lost after success may run fullRestore again.
    state.phase = 'finalizing';
    await save();
    if (!(await io.setupCompleted())) await io.completeSetup(); // idempotent state assignment
    if (state.restart === 'pending') {
      state.restart = 'requested';
      await save();
      await io.restartControl();
      state.restart = 'acknowledged';
      await save();
    }
    state.phase = 'completed'; state.status = 'completed';
    await save();
    io.settle();
    return state;
  } catch (error) {
    // No settlement on failure, including missing durable evidence or uncertain
    // restart acknowledgement. Never turn a raw backup exception into API text.
    if (error instanceof SetupRestoreError && error.code === 'operator-required') state.operatorRequired = true;
    if (state.phase !== 'completed') state.status = 'failed';
    await save().catch(() => undefined);
    if (error instanceof SetupRestoreError) throw error;
    throw new SetupRestoreError('restore-failed');
  }
}

/** Machine-local CLI identity is explicitly preserved by setup volume restore.
 * Only its digest is retained; the secret is never returned or logged.
 */
export function setupRestoreTargetIdentity(machineCredential: string): string {
  if (!machineCredential.trim()) throw new SetupRestoreError('state-unavailable');
  return createHash('sha256').update('youeye.setup-restore.target/1\0').update(machineCredential).digest('hex');
}
