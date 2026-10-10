/**
 * Durable app-update receipts. This store is deliberately payload-free: secrets,
 * SQL, manifests and metadata bodies belong in the protected recovery workspace.
 *
 * A receipt records intent, not proof that an external mutation completed.
 * An unfinished step must be reconciled/restored, never automatically replayed.
 */
import {
  constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, readSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { AppUpdateExecutorLock, withAppUpdateExecutorLock } from './update-executor-lock';

export const APP_UPDATE_SCHEMA = 'youeye.app-update.v1';
const DEFAULT_DIRECTORY = '/var/lib/youeye/state/app-updates';
const MAX_RECORD_BYTES = 1024 * 1024;
const identifier = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const digest = /^[a-f0-9]{64}$/;
const operationId = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const persistenceAuthority = Symbol('app-update-journal-writer');

export type AppUpdatePhase =
  | 'preflight' | 'quiescing' | 'checkpointing' | 'prepared' | 'applying'
  | 'verifying' | 'committed' | 'cleanup' | 'recovering' | 'rolled_back' | 'recovery_required';

export interface UpdateResource {
  kind: 'app' | 'container' | 'volume' | 'database' | 'metadata' | 'capacity';
  /** Exact namespace: pool for volumes, engine instance for databases. */
  scope: string;
  name: string;
  ownerAppId: string;
  mutable: boolean;
}

export interface UpdateCheckpoint {
  resource: string;
  method: 'runtime-copy' | 'root-snapshot' | 'volume-snapshot' | 'logical-postgres' | 'scoped-metadata';
  reference: string;
  sha256: string;
  verifiedAt: string;
}

export interface AppUpdateRecord {
  schema: typeof APP_UPDATE_SCHEMA;
  id: string;
  appId: string;
  revision: number;
  phase: AppUpdatePhase;
  createdAt: string;
  updatedAt: string;
  source: { manifestSHA256: string; artifactSHA256: string[] };
  target: { manifestSHA256: string; artifactSHA256: string[] };
  resources: UpdateResource[];
  originalRunning: Record<string, boolean>;
  metadataBeforeSHA256: string;
  checkpoints: UpdateCheckpoint[];
  steps: { id: string; phase: AppUpdatePhase; state: 'intent' | 'completed' }[];
  recoveryPolicy: 'restore-before-retry';
  /** A bounded public error code, never a caught exception or command output. */
  errorCode?: string;
  commit?: { metadataAfterSHA256: string; verifiedAt: string };
  rollbackVerifiedAt?: string;
  cleanupComplete: boolean;
}

export type NewAppUpdate = Pick<AppUpdateRecord,
  'appId' | 'source' | 'target' | 'resources' | 'originalRunning' | 'metadataBeforeSHA256'>;

const transitions: Record<AppUpdatePhase, readonly AppUpdatePhase[]> = {
  preflight: ['quiescing', 'recovering', 'recovery_required'],
  quiescing: ['checkpointing', 'recovering', 'recovery_required'],
  checkpointing: ['prepared', 'recovering', 'recovery_required'],
  prepared: ['applying', 'recovering', 'recovery_required'],
  applying: ['verifying', 'recovering', 'recovery_required'],
  verifying: ['committed', 'recovering', 'recovery_required'],
  committed: ['cleanup'],
  cleanup: [],
  recovering: ['rolled_back', 'recovery_required'],
  rolled_back: ['cleanup'],
  recovery_required: ['recovering'],
};

export function updateResourceKey(resource: UpdateResource): string {
  return createHash('sha256')
    .update(JSON.stringify([resource.kind, resource.scope, resource.name]))
    .digest('hex');
}

export function updateNeedsRecovery(record: AppUpdateRecord): boolean {
  return !record.cleanupComplete;
}

function fail(): never {
  throw new Error('App update journal is corrupt or insecure; recovery must remain blocked');
}

function privateDirectory(directory: string): void {
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.uid !== process.geteuid?.() || (stat.mode & 0o777) !== 0o700) fail();
}

function syncDirectory(directory: string): void {
  const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function validate(value: unknown): AppUpdateRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const r = value as AppUpdateRecord;
  // Reject unknown top-level fields rather than silently accepting payloads.
  const allowed = new Set([
    'schema', 'id', 'appId', 'revision', 'phase', 'createdAt', 'updatedAt', 'source', 'target',
    'resources', 'originalRunning', 'metadataBeforeSHA256', 'checkpoints', 'steps',
    'recoveryPolicy', 'errorCode', 'commit', 'rollbackVerifiedAt', 'cleanupComplete',
  ]);
  if (Object.keys(r).some(key => !allowed.has(key))
    || r.schema !== APP_UPDATE_SCHEMA || !operationId.test(r.id)
    || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(r.appId)
    || !Number.isSafeInteger(r.revision) || r.revision < 0
    || !Object.hasOwn(transitions, r.phase)
    || !validTime(r.createdAt) || !validTime(r.updatedAt)
    || !digest.test(r.metadataBeforeSHA256)
    || r.recoveryPolicy !== 'restore-before-retry'
    || typeof r.cleanupComplete !== 'boolean'
    || (r.errorCode !== undefined && !/^[a-z][a-z0-9_-]{0,95}$/.test(r.errorCode))) fail();
  for (const identity of [r.source, r.target]) {
    if (!identity || Object.keys(identity).some(k => !['manifestSHA256', 'artifactSHA256'].includes(k))
      || !digest.test(identity.manifestSHA256) || !Array.isArray(identity.artifactSHA256)
      || !identity.artifactSHA256.every(d => typeof d === 'string' && digest.test(d))) fail();
  }
  if (!Array.isArray(r.resources) || r.resources.length === 0 || r.resources.length > 1024) fail();
  for (const resource of r.resources) {
    if (!resource || Object.keys(resource).some(k => !['kind', 'scope', 'name', 'ownerAppId', 'mutable'].includes(k))
      || !['app', 'container', 'volume', 'database', 'metadata', 'capacity'].includes(resource.kind)
      || typeof resource.scope !== 'string' || !identifier.test(resource.scope)
      || typeof resource.name !== 'string' || !identifier.test(resource.name)
      || resource.ownerAppId !== r.appId || typeof resource.mutable !== 'boolean'
      || (resource.kind === 'capacity' && resource.mutable)) fail();
  }
  const keys = r.resources.map(updateResourceKey);
  if (new Set(keys).size !== keys.length
    || !r.resources.some(x => x.kind === 'app' && x.name === r.appId)) fail();
  if (!r.originalRunning || Array.isArray(r.originalRunning)
    || typeof r.originalRunning !== 'object') fail();
  for (const [name, running] of Object.entries(r.originalRunning)) {
    if (typeof running !== 'boolean'
      || !r.resources.some(x => x.kind === 'container' && x.name === name)) fail();
  }
  if (r.resources.some(x => x.kind === 'container' && !Object.hasOwn(r.originalRunning, x.name))) fail();
  if (!Array.isArray(r.checkpoints) || !Array.isArray(r.steps)) fail();
  for (const c of r.checkpoints) {
    if (!c || Object.keys(c).some(k => !['resource', 'method', 'reference', 'sha256', 'verifiedAt'].includes(k))
      || !keys.includes(c.resource) || typeof c.reference !== 'string' || !identifier.test(c.reference)
      || !digest.test(c.sha256)
      || !validTime(c.verifiedAt)
      || !['runtime-copy', 'root-snapshot', 'volume-snapshot', 'logical-postgres', 'scoped-metadata'].includes(c.method)) fail();
    const kind = r.resources.find(x => updateResourceKey(x) === c.resource)!.kind;
    const compatible: Record<UpdateResource['kind'], readonly UpdateCheckpoint['method'][]> = {
      app: [], container: ['runtime-copy', 'root-snapshot'], volume: ['volume-snapshot'],
      database: ['logical-postgres'], metadata: ['scoped-metadata'], capacity: [],
    };
    if (!compatible[kind].includes(c.method)) fail();
  }
  if (new Set(r.checkpoints.map(c => c.resource)).size !== r.checkpoints.length) fail();
  for (const step of r.steps) {
    if (!step || Object.keys(step).some(k => !['id', 'phase', 'state'].includes(k))
      || typeof step.id !== 'string' || !identifier.test(step.id) || !Object.hasOwn(transitions, step.phase)
      || !['intent', 'completed'].includes(step.state)) fail();
  }
  if (new Set(r.steps.map(s => s.id)).size !== r.steps.length) fail();
  if (r.commit && (Object.keys(r.commit).some(k => !['metadataAfterSHA256', 'verifiedAt'].includes(k))
    || !digest.test(r.commit.metadataAfterSHA256) || !validTime(r.commit.verifiedAt))) fail();
  if (r.rollbackVerifiedAt !== undefined && !validTime(r.rollbackVerifiedAt)) fail();
  if (r.rollbackVerifiedAt && !['rolled_back', 'cleanup'].includes(r.phase)) fail();
  if (r.commit && r.rollbackVerifiedAt) fail();
  if (r.commit && !['committed', 'cleanup'].includes(r.phase)) fail();
  if (r.phase === 'committed' && !r.commit) fail();
  if (r.phase === 'rolled_back' && !r.rollbackVerifiedAt) fail();
  if (r.phase === 'cleanup' && !r.commit && !r.rollbackVerifiedAt) fail();
  if ((['committed', 'rolled_back'].includes(r.phase) || r.cleanupComplete)
    && r.steps.some(s => s.state === 'intent')) fail();
  if (r.phase === 'cleanup' && r.steps.some(s => s.state === 'intent' && s.phase !== 'cleanup')) fail();
  if (r.cleanupComplete && (r.phase !== 'cleanup' || (!r.commit && !r.rollbackVerifiedAt))) fail();
  if ((['prepared', 'applying', 'verifying', 'committed'].includes(r.phase) || r.commit)
    && r.resources.some(resource => resource.mutable && resource.kind !== 'app'
      && !r.checkpoints.some(c => c.resource === updateResourceKey(resource)))) fail();
  return r;
}

function validTime(value: unknown): boolean {
  return typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value));
}

/**
 * Resource reservations never expire by PID or age. Process death therefore
 * retains evidence and exclusion. Recovery will explicitly reconcile reservations;
 * this store never interprets a dead writer as a completed transaction.
 */
export class AppUpdateJournalStore {
  constructor(readonly directory = DEFAULT_DIRECTORY) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    privateDirectory(directory);
    for (const child of ['operations', 'locks', 'writers', 'executors']) {
      const candidate = path.join(directory, child);
      mkdirSync(candidate, { mode: 0o700, recursive: true });
      privateDirectory(candidate);
    }
    syncDirectory(directory);
  }

  read(id: string): AppUpdateRecord {
    if (!operationId.test(id)) fail();
    privateDirectory(path.join(this.directory, 'operations'));
    const fd = openSync(path.join(this.directory, 'operations', `${id}.json`),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.uid !== process.geteuid?.()
        || (stat.mode & 0o777) !== 0o600 || stat.size > MAX_RECORD_BYTES) fail();
      const bytes = Buffer.alloc(MAX_RECORD_BYTES + 1);
      let length = 0;
      while (length < bytes.length) {
        const count = readSync(fd, bytes, length, bytes.length - length, null);
        if (count === 0) break;
        length += count;
      }
      if (length > MAX_RECORD_BYTES) fail();
      const record = validate(JSON.parse(bytes.subarray(0, length).toString('utf8')));
      if (record.id !== id) fail();
      return record;
    } finally { closeSync(fd); }
  }

  list(): AppUpdateRecord[] {
    privateDirectory(path.join(this.directory, 'operations'));
    return readdirSync(path.join(this.directory, 'operations'))
      .filter(name => name.endsWith('.json'))
      .sort().map(name => this.read(name.slice(0, -5)));
  }

  isReserved(resource: UpdateResource): boolean {
    // Unreadable/partial state is deliberately an admission failure.
    try {
      const records = this.list();
      if (records.some(r => updateNeedsRecovery(r)
        && r.resources.some(x => updateResourceKey(x) === updateResourceKey(resource)))) return true;
      try {
        lstatSync(path.join(this.directory, 'locks', updateResourceKey(resource)));
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        return false;
      }
    } catch { return true; }
  }

  create(input: NewAppUpdate): AppUpdateJournalLease {
    return this.withAdmission(() => this.createUnderAdmission(input));
  }

  /**
   * Acquire the existing operation exclusively, then read its latest receipt.
   * Missing resource reservations still exclude admission through the receipt;
   * takeover does not acknowledge intents or change recovery/commit evidence.
   */
  recover(id: string): AppUpdateJournalLease {
    if (!operationId.test(id)) fail();
    const executor = this.acquireExecutor(id);
    try {
      return this.withAdmission(() => {
        const record = this.read(id);
        if (record.cleanupComplete) throw new Error('App update operation is already cleaned up');
        return new AppUpdateJournalLease(this, record, executor, persistenceAuthority);
      });
    } catch (error) {
      executor.release();
      throw error;
    }
  }

  resume(id: string): AppUpdateJournalLease { return this.recover(id); }

  /** Runtime adapters keep all effects inside this callback; release keeps reservations. */
  async withExecutor<T>(
    inputOrId: NewAppUpdate | string, work: (lease: AppUpdateJournalLease) => T | Promise<T>,
  ): Promise<T> {
    const lease = typeof inputOrId === 'string' ? this.recover(inputOrId) : this.create(inputOrId);
    try { return await work(lease); } finally { lease.release(); }
  }

  private acquireExecutor(id: string): AppUpdateExecutorLock {
    privateDirectory(path.join(this.directory, 'executors'));
    return AppUpdateExecutorLock.acquire(path.join(this.directory, 'executors', `${id}.lock`));
  }

  /** Short OS-held guard shared by admission and final reservation release. */
  withAdmission<T>(work: () => T): T {
    privateDirectory(this.directory);
    return withAppUpdateExecutorLock(path.join(this.directory, 'admission.flock'), () => {
      // Upgrade residue only. All running store instances must use OS fencing;
      // rolling coexistence with the old unfenced implementation is unsupported.
      const legacy = path.join(this.directory, 'admission.lock');
      try {
        privateDirectory(legacy);
        rmdirSync(legacy); // Refuse nonempty, foreign or insecure legacy guards.
        syncDirectory(this.directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      return work();
    });
  }

  private createUnderAdmission(input: NewAppUpdate): AppUpdateJournalLease {
    const now = new Date().toISOString();
    const record = validate({
      ...structuredClone(input), schema: APP_UPDATE_SCHEMA, id: randomUUID(), revision: 0,
      phase: 'preflight', createdAt: now, updatedAt: now,
      checkpoints: [], steps: [], recoveryPolicy: 'restore-before-retry', cleanupComplete: false,
    });
    const keys = new Set(record.resources.map(updateResourceKey));
    if (this.list().some(r => updateNeedsRecovery(r)
      && r.resources.some(resource => keys.has(updateResourceKey(resource))))) {
      throw new Error('App update resources are reserved by an unfinished operation');
    }
    // Publish inventory BEFORE reservations: death during acquisition remains
    // discoverable, including an interrupted operation with no locks yet.
    const executor = this.acquireExecutor(record.id);
    const acquired: string[] = [];
    try {
      this.write(record, persistenceAuthority);
      for (const key of record.resources.map(updateResourceKey).sort()) {
        const lock = path.join(this.directory, 'locks', key);
        mkdirSync(lock, { mode: 0o700 });
        acquired.push(lock);
        const fd = openSync(path.join(lock, 'owner'), 'wx', 0o600);
        try { writeFileSync(fd, record.id); fsyncSync(fd); } finally { closeSync(fd); }
        syncDirectory(lock);
      }
      syncDirectory(path.join(this.directory, 'locks'));
      return new AppUpdateJournalLease(this, record, executor, persistenceAuthority);
    } catch (error) {
      // No external effects are permitted before create returns.
      try {
        for (const lock of acquired.reverse()) {
          try { unlinkSync(path.join(lock, 'owner')); } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
          }
          rmdirSync(lock);
        }
        const time = new Date().toISOString();
        this.write({ ...record, revision: 1, phase: 'cleanup', rollbackVerifiedAt: time,
          cleanupComplete: true, updatedAt: time, errorCode: 'resource-lock-conflict' }, persistenceAuthority);
        syncDirectory(path.join(this.directory, 'locks'));
        throw error;
      } finally { executor.release(); }
    }
  }

  /** Internal persistence; mutation callers must hold the operation writer. */
  write(record: AppUpdateRecord, authority: symbol): void {
    if (authority !== persistenceAuthority) fail();
    validate(record);
    const raw = `${JSON.stringify(record)}\n`;
    if (Buffer.byteLength(raw) > MAX_RECORD_BYTES) fail();
    const directory = path.join(this.directory, 'operations');
    privateDirectory(directory);
    const temporary = path.join(directory, `.${record.id}.${randomUUID()}.tmp`);
    try {
      const fd = openSync(temporary, 'wx', 0o600);
      try { writeFileSync(fd, raw); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporary, path.join(directory, `${record.id}.json`));
      syncDirectory(directory);
    } finally {
      try { unlinkSync(temporary); } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
    }
  }
}

export class AppUpdateJournalLease {
  constructor(
    private readonly store: AppUpdateJournalStore,
    private record: AppUpdateRecord,
    private readonly executor: AppUpdateExecutorLock,
    authority: symbol,
  ) {
    if (authority !== persistenceAuthority) fail();
  }

  snapshot(): AppUpdateRecord { return structuredClone(this.record); }

  assertActive(): void { this.executor.assertHeld(); }

  /** Release executor ownership only. Incomplete receipts/reservations survive. */
  release(): void { this.executor.release(); }

  private save(change: Partial<AppUpdateRecord>): void {
    this.assertActive();
    if (this.store.read(this.record.id).revision !== this.record.revision) {
      throw new Error('App update journal revision conflict');
    }
    const next = { ...this.record, ...change, revision: this.record.revision + 1,
      updatedAt: new Date().toISOString() };
    this.store.write(next, persistenceAuthority);
    this.record = structuredClone(next);
  }

  transition(phase: AppUpdatePhase): void {
    this.assertActive();
    if (phase === this.record.phase) return;
    if (!transitions[this.record.phase].includes(phase)) {
      throw new Error(`Invalid app update transition: ${this.record.phase} -> ${phase}`);
    }
    if (phase === 'prepared') {
      const missing = this.record.resources.filter(r => r.mutable && r.kind !== 'app')
        .some(r => !this.record.checkpoints.some(c => c.resource === updateResourceKey(r)));
      if (missing || this.record.steps.some(s => s.state === 'intent')) {
        throw new Error('App update checkpoint has not been verified for every mutable resource');
      }
    }
    if (phase === 'committed' || phase === 'rolled_back') {
      throw new Error('Verified completion requires an explicit receipt');
    }
    this.save({ phase });
  }

  checkpoint(checkpoint: UpdateCheckpoint): void {
    if (this.record.phase !== 'checkpointing') throw new Error('Checkpoint outside checkpointing phase');
    if (this.record.checkpoints.some(c => c.resource === checkpoint.resource)) {
      throw new Error('Checkpoint already recorded');
    }
    this.save({ checkpoints: [...this.record.checkpoints, checkpoint] });
  }

  intent(id: string): void {
    if (['committed', 'rolled_back'].includes(this.record.phase) || this.record.cleanupComplete) {
      throw new Error('App update no longer permits external mutation');
    }
    if (this.record.steps.some(s => s.id === id)) {
      throw new Error('App update step already exists; reconcile its outcome before retry');
    }
    this.save({ steps: [...this.record.steps, { id, phase: this.record.phase, state: 'intent' }] });
  }

  complete(id: string): void {
    if (!this.record.steps.some(s => s.id === id)) throw new Error('App update step has no recorded intent');
    this.save({ steps: this.record.steps.map(s => s.id === id ? { ...s, state: 'completed' } : s) });
  }

  commit(metadataAfterSHA256: string): void {
    if (this.record.phase !== 'verifying' || this.record.steps.some(s => s.state === 'intent')) {
      throw new Error('App update cannot commit with unfinished mutations or verification');
    }
    this.save({ phase: 'committed', commit: { metadataAfterSHA256, verifiedAt: new Date().toISOString() } });
  }

  rolledBack(): void {
    if (this.record.phase !== 'recovering' || this.record.steps.some(s => s.state === 'intent')) {
      throw new Error('App update rollback must reconcile all unfinished mutations');
    }
    this.save({ phase: 'rolled_back', rollbackVerifiedAt: new Date().toISOString() });
  }

  recoveryRequired(errorCode: string): void {
    if (this.record.commit || this.record.rollbackVerifiedAt) {
      throw new Error('Verified completion cannot be turned into rollback');
    }
    this.save({ phase: 'recovery_required', errorCode });
  }

  finishCleanup(): void {
    if (this.record.cleanupComplete) return;
    this.assertActive();
    if (this.record.phase !== 'cleanup' || this.record.steps.some(s => s.state === 'intent'
      && !/^release-[a-f0-9]{64}$/.test(s.id))) {
      throw new Error('App update cleanup is not verified');
    }
    this.store.withAdmission(() => {
      for (const key of this.record.resources.map(updateResourceKey).sort().reverse()) {
        const lock = path.join(this.store.directory, 'locks', key);
        const stepId = `release-${key}`;
        const step = this.record.steps.find(s => s.id === stepId);
        if (step?.state === 'completed') continue;
        let owner: string | undefined;
        let reservationExists = false;
        try {
          privateDirectory(lock);
          reservationExists = true;
          const fd = openSync(path.join(lock, 'owner'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          try {
            const stat = fstatSync(fd);
            if (!stat.isFile() || stat.uid !== process.geteuid?.()
              || (stat.mode & 0o777) !== 0o600 || stat.size !== 36) fail();
            owner = readFileSync(fd, 'utf8');
          } finally { closeSync(fd); }
        } catch (error) {
          // Death after receipt publication may precede reservation creation.
          // An existing ownerless directory remains unknown unless release intent
          // proves that this operation may already have removed its owner file.
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT'
            || (reservationExists && !step)) throw error;
        }
        if (owner !== undefined && owner !== this.record.id) fail();
        if (!step) this.intent(stepId);
        if (owner !== undefined) unlinkSync(path.join(lock, 'owner'));
        try { rmdirSync(lock); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        syncDirectory(path.join(this.store.directory, 'locks'));
        this.complete(stepId);
      }
      // Terminal evidence follows durable release of every owned reservation.
      this.save({ cleanupComplete: true });
    });
    this.release();
  }
}

export type AppUpdateLease = AppUpdateJournalLease;
