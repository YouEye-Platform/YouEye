/**
 * Durable coordination between container mutators and recovery/watchdog code.
 *
 * Next.js may bundle the updater, health monitor, and app prober into separate
 * module instances. Filesystem locks and attempt records are therefore the
 * authority; process-local Sets are intentionally not used.
 */

import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const DEFAULT_STATE_DIRECTORY = '/var/lib/youeye/state/container-maintenance';
const SCHEMA = 'youeye.container-maintenance/1';

export type ContainerMaintenanceState = 'active' | 'rollback' | 'failed' | 'completed';

interface ContainerMaintenanceRecord {
  schema: typeof SCHEMA;
  id: string;
  operation: string;
  containers: string[];
  state: ContainerMaintenanceState;
  pid: number;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  error?: string;
}

export interface ContainerMaintenanceOptions {
  stateDirectory?: string;
  operation?: string;
}

export interface ContainerMaintenanceLease {
  id: string;
  containers: string[];
  markRollback(error?: string): void;
  markFailed(error: string): void;
  release(): void;
}

function normalizeContainerNames(names: Iterable<string>): string[] {
  const containers = [...new Set(names)].filter((name) => name.length > 0).sort();
  if (containers.length === 0) throw new Error('Container maintenance requires at least one container');
  for (const name of containers) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(name)) {
      throw new Error('Container maintenance received an invalid container name');
    }
  }
  return containers;
}

function stateDirectory(options?: ContainerMaintenanceOptions): string {
  return options?.stateDirectory
    ?? process.env.YOUEYE_CONTAINER_MAINTENANCE_DIR
    ?? DEFAULT_STATE_DIRECTORY;
}

function ensureDirectory(directory: string): void {
  mkdirSync(path.join(directory, 'operations'), { recursive: true, mode: 0o700 });
  mkdirSync(path.join(directory, 'locks'), { recursive: true, mode: 0o700 });
  for (const candidate of [directory, path.join(directory, 'operations'), path.join(directory, 'locks')]) {
    chmodSync(candidate, 0o700);
    const observed = lstatSync(candidate);
    if (!observed.isDirectory() || (observed.mode & 0o077) !== 0) {
      throw new Error('Container maintenance state directory is unsafe');
    }
  }
}

function fsyncDirectory(directory: string): void {
  const fd = openSync(directory, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function safeError(value: string | undefined): string | undefined {
  return value?.replace(/\b(Bearer)\s+\S+/gi, '$1 [REDACTED]').slice(0, 2_048);
}

function validateRecord(value: unknown): ContainerMaintenanceRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid maintenance record');
  const record = value as Partial<ContainerMaintenanceRecord>;
  if (record.schema !== SCHEMA
    || typeof record.id !== 'string'
    || typeof record.operation !== 'string'
    || !Array.isArray(record.containers)
    || !record.containers.every((name) => typeof name === 'string')
    || !['active', 'rollback', 'failed', 'completed'].includes(String(record.state))
    || !Number.isInteger(record.pid)
    || typeof record.startedAt !== 'string'
    || typeof record.updatedAt !== 'string') {
    throw new Error('Invalid maintenance record');
  }
  return record as ContainerMaintenanceRecord;
}

function writeRecord(directory: string, record: ContainerMaintenanceRecord): void {
  const operations = path.join(directory, 'operations');
  const destination = path.join(operations, `${record.id}.json`);
  const temporary = path.join(operations, `.${record.id}.${randomUUID()}.tmp`);
  const fd = openSync(temporary, 'wx', 0o600);
  let closed = false;
  try {
    writeFileSync(fd, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    closed = true;
    renameSync(temporary, destination);
  } finally {
    if (!closed) closeSync(fd);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  chmodSync(destination, 0o600);
  fsyncDirectory(operations);
}

function readRecords(directory: string): ContainerMaintenanceRecord[] {
  ensureDirectory(directory);
  return readdirSync(path.join(directory, 'operations'))
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => {
      const file = path.join(directory, 'operations', entry);
      const observed = lstatSync(file);
      if (!observed.isFile() || (observed.mode & 0o077) !== 0) {
        throw new Error('Container maintenance record is unsafe');
      }
      return validateRecord(JSON.parse(readFileSync(file, 'utf8')));
    });
}

export function isContainerMaintenanceActive(
  name: string,
  options?: ContainerMaintenanceOptions,
): boolean {
  try {
    return readRecords(stateDirectory(options)).some(
      (record) => record.containers.includes(name) && record.state !== 'completed',
    );
  } catch {
    // An unreadable durable coordination store makes the mutation boundary
    // unknowable. Suppress recovery rather than racing a possible update.
    return true;
  }
}

export function beginContainerMaintenance(
  names: Iterable<string>,
  options: ContainerMaintenanceOptions = {},
): ContainerMaintenanceLease {
  const containers = normalizeContainerNames(names);
  const directory = stateDirectory(options);
  ensureDirectory(directory);
  const locks = path.join(directory, 'locks');
  const acquired: string[] = [];
  try {
    for (const name of containers) {
      const lock = path.join(locks, `${name}.lock`);
      mkdirSync(lock, { mode: 0o700 });
      acquired.push(lock);
    }
  } catch (error) {
    for (const lock of acquired.reverse()) rmdirSync(lock);
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error('Container maintenance already active for an update target');
    }
    throw error;
  }

  const now = new Date().toISOString();
  const record: ContainerMaintenanceRecord = {
    schema: SCHEMA,
    id: randomUUID(),
    operation: options.operation ?? 'container-update',
    containers,
    state: 'active',
    pid: process.pid,
    startedAt: now,
    updatedAt: now,
  };
  try {
    writeRecord(directory, record);
  } catch (error) {
    for (const lock of acquired.reverse()) rmdirSync(lock);
    throw error;
  }

  let released = false;
  const transition = (state: ContainerMaintenanceState, error?: string): void => {
    if (released) return;
    record.state = state;
    record.error = safeError(error);
    record.updatedAt = new Date().toISOString();
    if (state === 'completed') record.completedAt = record.updatedAt;
    writeRecord(directory, record);
  };
  return {
    id: record.id,
    containers,
    markRollback: (error) => transition('rollback', error),
    markFailed: (error) => transition('failed', error),
    release: () => {
      if (released) return;
      transition('completed');
      released = true;
      for (const lock of [...acquired].reverse()) {
        if (existsSync(lock)) rmdirSync(lock);
      }
      fsyncDirectory(locks);
    },
  };
}

export async function withContainerMaintenance<T>(
  names: Iterable<string>,
  operation: () => Promise<T>,
  options: ContainerMaintenanceOptions = {},
): Promise<T> {
  const lease = beginContainerMaintenance(names, options);
  try {
    return await operation();
  } finally {
    lease.release();
  }
}
