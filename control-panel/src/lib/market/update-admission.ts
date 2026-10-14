/**
 * Shared admission for app update, recovery and ordinary lifecycle mutations.
 * Callers hold the per-app OS lock for the entire transaction, including awaits.
 * Update callers must create their journal receipt inside this callback; recovery
 * callers must additionally acquire store.recover(recoveryOperationId).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { AppUpdateExecutorLock } from './update-executor-lock';
import {
  AppUpdateJournalStore, updateNeedsRecovery, updateResourceKey, type UpdateResource,
} from './update-journal';

export interface AppLifecycleOptions {
  store?: AppUpdateJournalStore;
  /** Additional exact resources, e.g. volumes involved in a storage move. */
  resources?: UpdateResource[];
  /** Only explicit recovery may enter an unfinished operation. */
  recoveryOperationId?: string;
}

interface HeldApp {
  lock: AppUpdateExecutorLock;
  active: boolean;
}

// Next may bundle this helper more than once in a single process.
const contextKey = Symbol.for('youeye.app-lifecycle-admission');
const globalContext = globalThis as typeof globalThis & {
  [contextKey]?: AsyncLocalStorage<Map<string, HeldApp>>;
};
const context = globalContext[contextKey] ??= new AsyncLocalStorage<Map<string, HeldApp>>();

export class AppLifecycleAdmissionError extends Error {
  readonly code = 'recovery_required';
  constructor(message = 'App resources are reserved by an unfinished update; explicit recovery is required') {
    super(message);
    this.name = 'AppLifecycleAdmissionError';
  }
}

/** Shared with the host coordinator. Process death never removes a reservation. */
async function withCoreLifecycle<T>(directory: string, work: () => T | Promise<T>): Promise<T> {
  const lock = AppUpdateExecutorLock.acquire(path.join(directory, 'core-lifecycle.flock'), 'shared');
  try {
    let fd: number;
    try { fd = openSync(path.join(directory, 'core-reservation.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return await work();
      throw new AppLifecycleAdmissionError('System lifecycle reservation is unreadable; recovery must remain blocked');
    }
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.uid !== process.geteuid?.() || (stat.mode & 0o777) !== 0o600 || stat.size > 4096) {
        throw new AppLifecycleAdmissionError('System lifecycle reservation is insecure; recovery must remain blocked');
      }
      let record: Record<string, unknown>;
      try { record = JSON.parse(readFileSync(fd, 'utf8')) as Record<string, unknown>; }
      catch { throw new AppLifecycleAdmissionError('System lifecycle reservation is invalid; recovery must remain blocked'); }
      if (record.schema !== 'youeye.core-lifecycle.v1' || typeof record.request_id !== 'string'
        || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(record.request_id)
        || typeof record.manifest_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(record.manifest_sha256)) {
        throw new AppLifecycleAdmissionError('System lifecycle reservation is invalid; recovery must remain blocked');
      }
      throw new AppLifecycleAdmissionError('A System update owns the platform lifecycle; complete its update or recovery first');
    } finally { closeSync(fd); }
  } finally { lock.release(); }
}

export function appUpdateJournalStore(directory?: string): AppUpdateJournalStore {
  return new AppUpdateJournalStore(directory ?? process.env.YOUEYE_APP_UPDATE_JOURNAL_DIR);
}

export function isAppUpdateReserved(appId: string, store = appUpdateJournalStore()): boolean {
  return store.isReserved({ kind: 'app', scope: 'market', name: appId, ownerAppId: appId, mutable: false });
}

/** Marked runtime copies remain evidence, even though inventory names canonical instances only. */
export function assertRecoveryCopyAdmission(
  name: string,
  config: Record<string, string>,
  store: AppUpdateJournalStore,
): void {
  const operationId = config['user.youeye.update_operation'];
  const source = config['user.youeye.update_source'];
  if (!operationId && !source && !name.startsWith('ye-rollback-')) return;
  if (!operationId || !source) throw new AppLifecycleAdmissionError();
  try {
    const record = store.read(operationId);
    if (updateNeedsRecovery(record)
      || !record.resources.some(resource => resource.kind === 'container' && resource.name === source)) {
      throw new AppLifecycleAdmissionError();
    }
  } catch {
    throw new AppLifecycleAdmissionError();
  }
}

/**
 * Admission order: journal admission -> app OS lock -> receipt/resource checks.
 * Release admission before invoking work, retain the app lock until work settles.
 * All update/recovery entry points must use this wrapper as well as journal leases.
 * Neither process death nor lock release removes durable receipts/reservations.
 */
export async function withAppLifecycle<T>(appId: string, work: () => T | Promise<T>, options: AppLifecycleOptions = {}): Promise<T> {
  const store = options.store ?? appUpdateJournalStore();
  return withCoreLifecycle(store.directory, () => withAppLifecycleUnderCore(appId, work, { ...options, store }));
}

async function withAppLifecycleUnderCore<T>(
  appId: string,
  work: () => T | Promise<T>,
  options: AppLifecycleOptions = {},
): Promise<T> {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(appId)) throw new Error('Invalid app lifecycle ID');
  const store = options.store ?? appUpdateJournalStore();
  const key = `${path.resolve(store.directory)}:${appId}`;
  const inherited = context.getStore();
  const held = inherited?.get(key);
  if (held?.active) {
    held.lock.assertHeld();
    if (options.resources?.length) {
      store.withAdmission(() => {
        const unfinished = store.list().filter(updateNeedsRecovery);
        for (const resource of options.resources!) {
          const resourceKey = updateResourceKey(resource);
          const owners = unfinished.filter(record => record.resources.some(candidate =>
            updateResourceKey(candidate) === resourceKey));
          if (owners.some(record => record.appId !== appId)
            || (store.isReserved(resource) && !owners.some(record => record.appId === appId))) {
            throw new AppLifecycleAdmissionError();
          }
        }
      });
    }
    return await work();
  }

  const app: UpdateResource = { kind: 'app', scope: 'market', name: appId, ownerAppId: appId, mutable: false };
  const resources = [app, ...(options.resources ?? [])];
  let lock: AppUpdateExecutorLock | undefined;
  try {
    store.withAdmission(() => {
      lock = AppUpdateExecutorLock.acquire(path.join(store.directory, 'executors', `app-${appId}.lock`));
      if (options.recoveryOperationId) {
        const record = store.read(options.recoveryOperationId);
        if (record.appId !== appId || !updateNeedsRecovery(record)) throw new AppLifecycleAdmissionError();
        const keys = new Set([...record.resources, ...resources].map(updateResourceKey));
        if (store.list().some(other => other.id !== record.id && updateNeedsRecovery(other)
          && (other.appId === appId || other.resources.some(resource => keys.has(updateResourceKey(resource)))))) {
          throw new AppLifecycleAdmissionError();
        }
      } else if (resources.some(resource => store.isReserved(resource))
        || store.list().some(record => record.appId === appId && updateNeedsRecovery(record))) {
        throw new AppLifecycleAdmissionError();
      }
    });
    const entry: HeldApp = { lock: lock!, active: true };
    const scope = new Map(inherited);
    scope.set(key, entry);
    try {
      return await context.run(scope, async () => {
        entry.lock.assertHeld();
        return await work();
      });
    } finally {
      // Escaped asynchronous tasks cannot reuse a released admission.
      entry.active = false;
    }
  } finally {
    lock?.release();
  }
}

/** Container actions resolve exact recorded ownership; never split a dashed ID. */
export async function withContainerLifecycle<T>(
  name: string,
  work: () => T | Promise<T>,
  options: AppLifecycleOptions = {},
): Promise<T> {
  const store = options.store ?? appUpdateJournalStore();
  return withCoreLifecycle(store.directory, () => withContainerLifecycleUnderCore(name, work, { ...options, store }));
}

async function withContainerLifecycleUnderCore<T>(
  name: string,
  work: () => T | Promise<T>,
  options: AppLifecycleOptions = {},
): Promise<T> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(name)) throw new Error('Invalid container lifecycle name');
  const store = options.store ?? appUpdateJournalStore();
  const resource: UpdateResource = {
    kind: 'container', scope: 'incus', name, ownerAppId: 'container-action', mutable: true,
  };
  store.withAdmission(() => {
    if (store.isReserved(resource)) throw new AppLifecycleAdmissionError();
  });
  const guardedWork = async () => {
    const { incusRequest } = await import('../incus/server');
    const observed = await incusRequest<{ config?: Record<string, string> }>(
      'GET', `/1.0/instances/${encodeURIComponent(name)}`);
    if (observed.type === 'error' && observed.error_code !== 404 && observed.status_code !== 404) {
      throw new Error('Cannot verify container recovery ownership');
    }
    assertRecoveryCopyAdmission(name, observed.metadata?.config ?? {}, store);
    return await work();
  };
  const { listInstalledApps } = await import('./metadata');
  const owners = (await listInstalledApps()).filter(meta => meta.containers.some(container =>
    (typeof container === 'string' ? container : container.containerName) === name));
  if (owners.length > 1) throw new Error('Container lifecycle ownership is ambiguous');
  if (owners.length === 1) {
    return withAppLifecycle(owners[0].appId, guardedWork, { ...options, store, resources: [resource] });
  }
  if (name.startsWith('app-')) throw new Error('App container lifecycle ownership is unavailable');
  // System/foreign container actions have no app lock. Retain admission through
  // their whole operation so an update cannot reserve this container mid-action.
  return await store.withAdmission(async () => {
    if (store.isReserved(resource)) throw new AppLifecycleAdmissionError();
    return await guardedWork();
  });
}


/** Multi-app mutations retain every gate in a deterministic order. */
export async function withAppLifecycles<T>(appIds: string[], work: () => T | Promise<T>): Promise<T> {
  const ids = [...new Set(appIds)].sort();
  const next = (index: number): Promise<T> => index === ids.length
    ? Promise.resolve().then(work) : withAppLifecycle(ids[index], () => next(index + 1));
  return next(0);
}

/** Hold the app inventory stable before enumerating or changing installations.
 * The separate gate cannot collide with an app ID. Nested full/app restore reuses
 * its descriptor; other processes fail before creating or deleting metadata. */
export async function withAppInventory<T>(work: () => T | Promise<T>, options: Pick<AppLifecycleOptions, 'store'> = {}): Promise<T> {
  const store = options.store ?? appUpdateJournalStore();
  return withCoreLifecycle(store.directory, () => withAppInventoryUnderCore(work, { ...options, store }));
}

async function withAppInventoryUnderCore<T>(
  work: () => T | Promise<T>,
  options: Pick<AppLifecycleOptions, 'store'> = {},
): Promise<T> {
  const store = options.store ?? appUpdateJournalStore();
  const key = `${path.resolve(store.directory)}:#inventory`;
  const inherited = context.getStore();
  const held = inherited?.get(key);
  if (held?.active) { held.lock.assertHeld(); return await work(); }
  const lock = store.withAdmission(() => AppUpdateExecutorLock.acquire(
    path.join(store.directory, 'executors', 'inventory.lock')));
  const entry: HeldApp = { lock, active: true };
  const scope = new Map(inherited); scope.set(key, entry);
  try {
    return await context.run(scope, async () => { lock.assertHeld(); return await work(); });
  } finally { entry.active = false; lock.release(); }
}
