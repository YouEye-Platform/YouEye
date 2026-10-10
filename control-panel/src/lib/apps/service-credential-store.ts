/**
 * Protected authority for installation service credentials.
 *
 * Kept outside app data and container checkpoints so an ordinary app rollback
 * cannot restore a retired generation. Production callers use the fixed store.
 * No method serializes a secret for browser/API status.
 */
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  APP_SERVICE_CREDENTIAL_SCHEMA,
  checkAppCredentialTransition,
  isActiveAppCredential,
  isCanonicalAppId,
  parseAppCredentialProjection,
  sameAppCredential,
  type AppCredentialProjection,
} from '../../../../shared/app-service-credential';

import { withAppLifecycle } from '../market/update-admission';

const STATE_DIRECTORY = '/var/lib/youeye/state/app-service-credentials';
const SECRET_PATTERN = /^ye_app_v1_[A-Za-z0-9_-]{43}$/;
const FILE_LIMIT = 16_384;

interface StoredCredential {
  projection: AppCredentialProjection;
  secret: string | null;
  operationId: string;
  operationKind: 'provision' | 'rotate' | 'reinstall' | 'revoke' | 'restore';
  publishedRevision: number;
  publications: AppCredentialProjection[];
}

export interface AppCredentialStatusView extends Omit<AppCredentialProjection, 'verifierHash'> {
  operationId: string;
  operationKind: StoredCredential['operationKind'];
  publishedRevision: number;
  pendingPublications: number;
}

function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

function uid(): number {
  if (!process.geteuid) throw new Error('App credentials require POSIX ownership checks');
  return process.geteuid();
}

async function requireDirectory(directory: string): Promise<void> {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.uid !== uid() || (info.mode & 0o777) !== 0o700) {
    throw new Error('App credential storage is unsafe');
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

function parseStored(value: unknown, appId: string): StoredCredential {
  const fail = () => { throw new Error('App credential requires repair'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const data = value as Record<string, unknown>;
  if (Object.keys(data).sort().join(',') !== 'operationId,operationKind,projection,publications,publishedRevision,secret') return fail();
  const projection = parseAppCredentialProjection(data.projection);
  if (projection.appId !== appId || typeof data.operationId !== 'string'
    || !/^[0-9a-f-]{36}$/.test(data.operationId)
    || !['provision', 'rotate', 'reinstall', 'revoke', 'restore'].includes(String(data.operationKind))) return fail();
  if (projection.status === 'revoked') {
    if (data.secret !== null) return fail();
  } else if (typeof data.secret !== 'string' || !SECRET_PATTERN.test(data.secret)
    || hashSecret(data.secret) !== projection.verifierHash) return fail();
  if (!Number.isSafeInteger(data.publishedRevision) || (data.publishedRevision as number) < 0
    || (data.publishedRevision as number) > projection.revision || !Array.isArray(data.publications)
    || data.publications.length > 24) return fail();
  const publications = data.publications.map(parseAppCredentialProjection);
  if (publications.length !== projection.revision - (data.publishedRevision as number)) return fail();
  for (let i = 0; i < publications.length; i++) {
    if (publications[i].appId !== appId || publications[i].revision !== (data.publishedRevision as number) + i + 1) return fail();
    if (i > 0) checkAppCredentialTransition(publications[i - 1], publications[i], publications[i].revision - 1);
  }
  if (publications.length && JSON.stringify(publications.at(-1)) !== JSON.stringify(projection)) return fail();
  return {
    projection, secret: data.secret as string | null, operationId: data.operationId,
    operationKind: data.operationKind as StoredCredential['operationKind'],
    publishedRevision: data.publishedRevision as number, publications,
  };
}

async function processIdentity(pid: number): Promise<{ bootId: string; started: string }> {
  const bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
  const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
  const started = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
  if (!/^[0-9a-f-]{36}$/.test(bootId) || !/^\d+$/.test(started ?? '')) {
    throw new Error('App credential process identity is unavailable');
  }
  return { bootId, started };
}

/**
 * Explicit directory argument exists for isolated filesystem tests.
 * Callers must not obtain it from a manifest or browser request.
 */
export class AppServiceCredentialStore {
  constructor(
    private readonly directory: string,
    /** Isolated crash injection only; production singleton supplies no observer. */
    private readonly persistenceBoundary?: (boundary: 'file-synced' | 'renamed') => Promise<void>,
    private readonly lifecycle?: typeof withAppLifecycle,
  ) {}

  private appDirectory(appId: string): string {
    if (!isCanonicalAppId(appId)) throw new Error('Invalid app credential identity');
    return path.join(this.directory, appId);
  }

  private async ensureRoot(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await requireDirectory(this.directory);
  }

  private async read(appId: string): Promise<StoredCredential | null> {
    const directory = this.appDirectory(appId);
    try {
      await requireDirectory(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    try {
      const handle = await open(path.join(directory, 'credential.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.uid !== uid() || (info.mode & 0o777) !== 0o600 || info.size > FILE_LIMIT) {
          throw new Error('App credential storage is unsafe');
        }
        const record = parseStored(JSON.parse(await handle.readFile('utf8')), appId);
        // A prior rename may have succeeded before its directory sync failed.
        // Retry must make that record durable before publishing or using it.
        await syncDirectory(directory);
        return record;
      } finally { await handle.close(); }
    } catch {
      // An existing directory with an absent/corrupt record is never a new install.
      throw new Error('App credential requires repair');
    }
  }

  private async write(appId: string, record: StoredCredential): Promise<void> {
    if (record.projection.revision > record.publishedRevision
      && record.publications.at(-1)?.revision !== record.projection.revision) {
      record = { ...record, publications: [...record.publications, record.projection] };
    }
    const serialized = `${JSON.stringify(record)}\n`;
    if (record.publications.length > 24 || Buffer.byteLength(serialized) > FILE_LIMIT) {
      throw new Error('App credential publication backlog requires reconciliation');
    }
    const directory = this.appDirectory(appId);
    await requireDirectory(directory);
    const temporary = path.join(directory, `.credential-${randomUUID()}.tmp`);
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(serialized, 'utf8');
        await handle.sync();
      } finally { await handle.close(); }
      await this.persistenceBoundary?.('file-synced');
      await rename(temporary, path.join(directory, 'credential.json'));
      await this.persistenceBoundary?.('renamed');
      await syncDirectory(directory);
    } catch {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw new Error('App credential persistence failed');
    }
  }

  /** Cross-bundle serialization. A crash leaves an explicit recoverable lock. */
  private async locked<T>(appId: string, action: () => Promise<T>): Promise<T> {
    return this.lifecycle ? this.lifecycle(appId, () => this.lockedUnderLifecycle(appId, action))
      : this.lockedUnderLifecycle(appId, action);
  }

  private async lockedUnderLifecycle<T>(appId: string, action: () => Promise<T>): Promise<T> {
    this.appDirectory(appId);
    await this.ensureRoot();
    const lock = path.join(this.directory, `${appId}.lock`);
    try { await mkdir(lock, { mode: 0o700 }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error('App credential operation is pending; reconcile the lifecycle lock');
      }
      throw new Error('App credential lock persistence failed');
    }
    try {
      const owner = await open(path.join(lock, 'owner.json'), 'wx', 0o600);
      try {
        await owner.writeFile(JSON.stringify({ pid: process.pid, ...await processIdentity(process.pid) }));
        await owner.sync();
      } finally { await owner.close(); }
      await syncDirectory(lock);
      await syncDirectory(this.directory);
      return await action();
    } finally {
      await rm(lock, { recursive: true });
      await syncDirectory(this.directory);
    }
  }

  private nextRecord(
    appId: string,
    current: StoredCredential | null,
    reinstall = false,
  ): StoredCredential {
    const now = new Date().toISOString();
    const secret = `ye_app_v1_${randomBytes(32).toString('base64url')}`;
    return {
      projection: {
        schema: APP_SERVICE_CREDENTIAL_SCHEMA, appId,
        installationId: !current || reinstall ? randomUUID() : current.projection.installationId,
        generation: !current || reinstall ? 1 : current.projection.generation + 1,
        revision: (current?.projection.revision ?? 0) + 1,
        status: 'prepared', verifierHash: hashSecret(secret),
        createdAt: !current || reinstall ? now : current.projection.createdAt,
        rotatedAt: !current || reinstall ? null : now,
        revokedAt: null, expiresAt: null,
      },
      secret,
      operationId: randomUUID(),
      operationKind: !current ? 'provision' : reinstall ? 'reinstall' : 'rotate',
      publishedRevision: current?.publishedRevision ?? 0,
      publications: current?.publications ?? [],
    };
  }

  /** Only the install lifecycle may create a missing record. */
  async provisionForInstall(appId: string): Promise<AppCredentialProjection> {
    return this.locked(appId, async () => {
      const current = await this.read(appId);
      if (current) {
        if (current.projection.status === 'revoked') throw new Error('App credential reinstall requires explicit adoption');
        return { ...current.projection };
      }
      const record = this.nextRecord(appId, null);
      checkAppCredentialTransition(null, record.projection, 0);
      await mkdir(this.appDirectory(appId), { mode: 0o700 });
      await syncDirectory(this.directory);
      await this.write(appId, record);
      return { ...record.projection };
    });
  }

  /** Ordinary config rendering never creates a credential or clears revocation. */
  async runtimeSecret(appId: string): Promise<string> {
    return this.locked(appId, async () => {
      const current = await this.read(appId);
      if (!current?.secret || current.projection.status === 'revoked') {
        throw new Error('App service integration is not ready; reconcile credentials');
      }
      return current.secret;
    });
  }

  async projection(appId: string): Promise<AppCredentialProjection | null> {
    return this.locked(appId, async () => {
      const current = await this.read(appId);
      return current ? { ...current.projection } : null;
    });
  }

  async status(appId: string): Promise<AppCredentialStatusView | null> {
    return this.locked(appId, async () => {
      const current = await this.read(appId);
      if (!current) return null;
      const { verifierHash: _hash, ...projection } = current.projection;
      return { ...projection, operationId: current.operationId, operationKind: current.operationKind,
        publishedRevision: current.publishedRevision, pendingPublications: current.publications.length };
    });
  }

  async prepareRotation(appId: string, expectedRevision: number): Promise<AppCredentialProjection> {
    return this.locked(appId, async () => {
      const current = await this.read(appId);
      if (!current) throw new Error('App credential requires repair');
      if (current.projection.status === 'prepared'
        && current.operationKind === 'rotate'
        && current.projection.revision === expectedRevision + 1) {
        // Interrupted rotation: return the already-persisted generation.
        return { ...current.projection };
      }
      if (current.projection.status === 'prepared') {
        throw new Error('App credential operation is pending; reconcile the prepared generation');
      }
      const next = this.nextRecord(appId, current);
      checkAppCredentialTransition(current.projection, next.projection, expectedRevision);
      await this.write(appId, next);
      return { ...next.projection };
    });
  }

  async activate(appId: string, expectedRevision: number): Promise<AppCredentialProjection> {
    return this.locked(appId, async () => {
      const current = await this.read(appId);
      if (!current) throw new Error('App credential requires repair');
      if (current.projection.status === 'active' && current.projection.revision === expectedRevision + 1) {
        return { ...current.projection };
      }
      const projection: AppCredentialProjection = {
        ...current.projection, revision: expectedRevision + 1, status: 'active', revokedAt: null,
      };
      checkAppCredentialTransition(current.projection, projection, expectedRevision);
      await this.write(appId, { ...current, projection });
      return { ...projection };
    });
  }

  async revoke(appId: string, expectedRevision: number): Promise<AppCredentialProjection> {
    return this.locked(appId, async () => {
      const current = await this.read(appId);
      if (!current) throw new Error('App credential requires repair');
      if (current.projection.status === 'revoked' && current.projection.revision === expectedRevision + 1) {
        return { ...current.projection };
      }
      const projection: AppCredentialProjection = {
        ...current.projection, revision: expectedRevision + 1,
        status: 'revoked', revokedAt: new Date().toISOString(),
      };
      checkAppCredentialTransition(current.projection, projection, expectedRevision);
      await this.write(appId, { ...current, projection, secret: null, operationKind: 'revoke' });
      return { ...projection };
    });
  }

  /** Caller must verify ownership adoption under the app lifecycle lock. */
  async prepareReinstall(appId: string, expectedRevision: number): Promise<AppCredentialProjection> {
    return this.locked(appId, async () => {
      const current = await this.read(appId);
      if (current?.projection.status === 'prepared'
        && current.operationKind === 'reinstall'
        && current.projection.revision === expectedRevision + 1) {
        return { ...current.projection };
      }
      if (!current || current.projection.status !== 'revoked') throw new Error('App credential reinstall requires revocation');
      const next = this.nextRecord(appId, current, true);
      checkAppCredentialTransition(current.projection, next.projection, expectedRevision);
      await this.write(appId, next);
      return { ...next.projection };
    });
  }

  /** Explicit restore only: discard runtime authority, never import a backed-up secret. */
  async fenceForRestore(
    appId: string,
    observedUI: AppCredentialProjection | null,
    retainInstallation = false,
  ): Promise<AppCredentialProjection> {
    return this.locked(appId, async () => {
      const current = await this.read(appId);
      const observed = observedUI ? parseAppCredentialProjection(observedUI) : null;
      if (observed && observed.appId !== appId) throw new Error('App credential restore identity conflict');
      if (retainInstallation && (!current || (observed && observed.revision > current.projection.revision))) {
        throw new Error('Retained app credential authority requires repair');
      }
      if (current && ['revoke', 'restore'].includes(current.operationKind) && current.projection.status === 'revoked'
        && (!observed || current.projection.revision > observed.revision
          || sameAppCredential(current.projection, observed))) return { ...current.projection };
      const basis = observed && (!current || observed.revision > current.projection.revision)
        ? observed : current?.projection;
      const now = new Date().toISOString();
      const projection: AppCredentialProjection = parseAppCredentialProjection({
        ...(basis ?? {
          schema: APP_SERVICE_CREDENTIAL_SCHEMA, appId, installationId: randomUUID(),
          generation: 1, verifierHash: hashSecret(`ye_app_v1_${randomBytes(32).toString('base64url')}`),
          createdAt: now, rotatedAt: null, expiresAt: null,
        }),
        revision: Math.max(current?.projection.revision ?? 0, observed?.revision ?? 0) + 1,
        status: 'revoked', revokedAt: now,
      });
      if (!current) {
        await mkdir(this.appDirectory(appId), { mode: 0o700 });
        await syncDirectory(this.directory);
      }
      // This gap is published exclusively by the deny-only restore CAS.
      await this.write(appId, {
        projection, secret: null,
        operationKind: retainInstallation && current?.operationKind !== 'revoke' ? 'restore' : 'revoke',
        operationId: randomUUID(),
        publishedRevision: projection.revision - 1, publications: [],
      });
      return { ...projection };
    });
  }

  /**
   * Called only under the outer app lifecycle maintenance lock. A missing owner,
   * unsafe record, or live owner is an explicit repair condition, not permission
   * to steal a lock. PID start time and boot identity prevent PID-reuse mistakes.
   */
  async recoverAbandonedOperation(appId: string): Promise<void> {
    this.appDirectory(appId);
    await this.ensureRoot();
    const lock = path.join(this.directory, `${appId}.lock`);
    try { await requireDirectory(lock); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    let owner: { pid: number; bootId: string; started: string };
    try {
      const handle = await open(path.join(lock, 'owner.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.uid !== uid() || (info.mode & 0o777) !== 0o600 || info.size > FILE_LIMIT) {
          throw new Error('Unsafe lock owner');
        }
        owner = JSON.parse(await handle.readFile('utf8'));
      } finally { await handle.close(); }
      if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0
        || !/^[0-9a-f-]{36}$/.test(owner.bootId) || !/^\d+$/.test(owner.started)) {
        throw new Error('Invalid lock owner');
      }
    } catch {
      throw new Error('App credential lifecycle lock requires repair');
    }
    let live: { bootId: string; started: string } | null;
    try { live = await processIdentity(owner.pid); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      live = null;
    }
    if (live && live.bootId === owner.bootId && live.started === owner.started) {
      throw new Error('App credential operation is still running');
    }
    await rm(lock, { recursive: true });
    await syncDirectory(this.directory);
  }

  /** Existing CP gateway routes must use current-record equality, never HMAC authority. */
  async authenticate(appId: string, secret: string): Promise<AppCredentialProjection | null> {
    try {
      if (!SECRET_PATTERN.test(secret)) return null;
      return await this.locked(appId, async () => {
        const current = await this.read(appId);
        if (!current || !isActiveAppCredential(current.projection)) return null;
        const actual = Buffer.from(hashSecret(secret), 'hex');
        const expected = Buffer.from(current.projection.verifierHash, 'hex');
        return timingSafeEqual(actual, expected) ? { ...current.projection } : null;
      });
    } catch {
      return null;
    }
  }

  async installedCredentialIds(): Promise<string[]> {
    await this.ensureRoot();
    const entries = await readdir(this.directory, { withFileTypes: true });
    return entries.filter(entry => entry.isDirectory() && isCanonicalAppId(entry.name))
      .map(entry => entry.name).sort();
  }

  /** Secret-free durable outbox; publish the whole batch atomically at UI. */
  async pendingPublications(appId: string): Promise<AppCredentialProjection[]> {
    return this.locked(appId, async () => {
      const current = await this.read(appId);
      if (!current) throw new Error('App credential requires repair');
      return current.publications.map(projection => ({ ...projection }));
    });
  }

  async acknowledgePublication(appId: string, revision: number): Promise<void> {
    return this.locked(appId, async () => {
      const current = await this.read(appId);
      if (!current || revision > current.projection.revision
        || revision < current.publishedRevision || !Number.isSafeInteger(revision)) {
        throw new Error('App credential publication revision conflict');
      }
      await this.write(appId, {
        ...current, publishedRevision: revision,
        publications: current.publications.filter(projection => projection.revision > revision),
      });
    });
  }
}

export const appServiceCredentials = new AppServiceCredentialStore(STATE_DIRECTORY, undefined, withAppLifecycle);
