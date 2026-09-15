/**
 * Durable install-operation tracker.
 *
 * The browser SSE stream is disposable observation. The operation record below
 * is the authority used after refresh, disconnect, or Control Panel restart.
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
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import type { InstallEvent } from './types';

interface TrackedInstall {
  schema: 'youeye.install-operation/1';
  appId: string;
  appName: string;
  events: InstallEvent[];
  done: boolean;
  startedAt: number;
  updatedAt: number;
  runtimeOwner?: string;
  error?: string;
  cancelled?: boolean;
  abortController?: AbortController;
}

const OPERATIONS_DIR = process.env.YOUEYE_INSTALL_OPERATIONS_DIR
  ?? '/var/lib/youeye/networks/operations';
const activeInstalls = new Map<string, TrackedInstall>();

function processRuntimeOwner(pid: number): string | null {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const commandEnd = raw.lastIndexOf(')');
    if (commandEnd < 0) return null;
    // Field 22 is the process start time in clock ticks. The slice begins at
    // field 3 (state), so start time is index 19. PID plus start time remains
    // stable across separately bundled copies in one live Next.js process and
    // changes if the PID is later reused after a restart.
    const fields = raw.slice(commandEnd + 2).trim().split(/\s+/);
    const startTime = fields[19];
    return startTime && /^\d+$/.test(startTime) ? `${pid}:${startTime}` : null;
  } catch {
    return null;
  }
}

const CURRENT_RUNTIME_OWNER = processRuntimeOwner(process.pid);

function isRuntimeOwnerAlive(owner: string | undefined): boolean {
  if (!owner) return false;
  const match = owner.match(/^(\d+):(\d+)$/);
  if (!match) return false;
  return processRuntimeOwner(Number(match[1])) === owner;
}

export function sensitivitySafeInstallError(error: unknown): string {
  let current = error;
  const seen = new Set<unknown>();
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    if (['AppNetworkCapacityError', 'AppNetworkOperationConflictError', 'AppNetworkStateError'].includes(current.name)) {
      return sanitiseText(current.message) ?? 'App network preflight failed';
    }
    if (current.name === 'MarketNativeArtifactPolicyError') {
      return sanitiseText(current.message) ?? 'App package preflight failed';
    }
    current = (current as Error & { cause?: unknown }).cause;
  }
  return 'Installation failed; use the supported Health and repair views for sensitivity-safe diagnostics.';
}

function assertAppId(appId: string): void {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(appId)) throw new Error(`Invalid app ID: ${appId}`);
}

function operationPath(appId: string): string {
  assertAppId(appId);
  return path.join(OPERATIONS_DIR, `${appId}.json`);
}

function sanitiseText(value: string | undefined): string | undefined {
  if (!value) return value;
  return value
    .replace(/\b(Bearer)\s+[^\s"']+/gi, '$1 [REDACTED]')
    .replace(/\b(password|token|secret|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .slice(0, 4_096);
}

export function sanitiseInstallEvent(event: InstallEvent): InstallEvent {
  let safeUrl = event.errorContext?.url;
  if (safeUrl) {
    try {
      const parsed = new URL(safeUrl);
      parsed.username = '';
      parsed.password = '';
      parsed.search = '';
      parsed.hash = '';
      safeUrl = parsed.origin;
    } catch {
      safeUrl = undefined;
    }
  }
  return {
    ...event,
    message: sanitiseText(event.message) ?? '',
    // Arbitrary dependency errors frequently embed response payloads or
    // generated credentials. Keep them in the live SSE only, never on disk.
    detail: event.detail ? 'Additional diagnostic detail withheld from durable operation history' : undefined,
    errorContext: event.errorContext ? {
      method: event.errorContext.method,
      statusCode: event.errorContext.statusCode,
      suggestion: event.errorContext.suggestion
        ? 'Use the supported Health and repair views for sensitivity-safe diagnostics.'
        : undefined,
      url: safeUrl,
      responseBody: event.errorContext.responseBody ? '[REDACTED]' : undefined,
      resolvedVars: event.errorContext.resolvedVars
        ? Object.fromEntries(Object.keys(event.errorContext.resolvedVars).map((key) => [key, '[REDACTED]']))
        : undefined,
    } : undefined,
  };
}

function serialisable(install: TrackedInstall): Omit<TrackedInstall, 'abortController'> {
  const { abortController: _, ...record } = install;
  void _;
  return record;
}

function ensureDirectory(): void {
  if (!existsSync(OPERATIONS_DIR)) {
    mkdirSync(OPERATIONS_DIR, { recursive: true, mode: 0o700 });
  }
  const directory = lstatSync(OPERATIONS_DIR);
  if (!directory.isDirectory() || (directory.mode & 0o077) !== 0) {
    throw new Error('Durable install operation directory must be a real directory with mode 0700');
  }
  chmodSync(OPERATIONS_DIR, 0o700);
}

function fsyncDirectory(): void {
  const descriptor = openSync(OPERATIONS_DIR, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function persist(install: TrackedInstall): void {
  ensureDirectory();
  const output = operationPath(install.appId);
  const temp = path.join(OPERATIONS_DIR, `.${install.appId}.${process.pid}.${randomUUID()}.tmp`);
  try {
    const descriptor = openSync(temp, 'wx', 0o600);
    try {
      writeFileSync(descriptor, `${JSON.stringify(serialisable(install), null, 2)}\n`, 'utf8');
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    chmodSync(temp, 0o600);
    renameSync(temp, output);
    chmodSync(output, 0o600);
    fsyncDirectory();
  } catch (error) {
    try { unlinkSync(temp); } catch { /* already renamed or absent */ }
    throw error;
  }
}

function validateRecord(value: unknown): TrackedInstall {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Install operation must be an object');
  const record = value as Partial<TrackedInstall>;
  if (record.schema !== 'youeye.install-operation/1') throw new Error(`Unsupported install operation schema: ${String(record.schema)}`);
  if (typeof record.appId !== 'string') throw new Error('Install operation appId is missing');
  assertAppId(record.appId);
  if (typeof record.appName !== 'string' || !Array.isArray(record.events)
    || typeof record.done !== 'boolean' || typeof record.startedAt !== 'number'
    || typeof record.updatedAt !== 'number'
    || (record.runtimeOwner !== undefined && !/^\d+:\d+$/.test(record.runtimeOwner))) {
    throw new Error(`Install operation for ${record.appId} is invalid`);
  }
  return record as TrackedInstall;
}

function readPersisted(appId: string): TrackedInstall | undefined {
  const input = operationPath(appId);
  if (!existsSync(input)) return undefined;
  try {
    const inputStat = statSync(input);
    if (!inputStat.isFile() || (inputStat.mode & 0o077) !== 0) {
      throw new Error('operation file must be a regular file with mode 0600');
    }
    return validateRecord(JSON.parse(readFileSync(input, 'utf8')));
  } catch {
    throw new Error(`Durable install operation for ${appId} is corrupt or insecure`);
  }
}

function load(appId: string): TrackedInstall | undefined {
  return activeInstalls.get(appId) ?? readPersisted(appId);
}

export function startTracking(appId: string, appName: string): AbortController {
  assertAppId(appId);
  const prior = load(appId);
  if (prior && !prior.done) {
    throw new Error(`An install operation for ${appId} is already active; wait for reconciliation or use the supported repair path`);
  }
  const abortController = new AbortController();
  const now = Date.now();
  const install: TrackedInstall = {
    schema: 'youeye.install-operation/1',
    appId,
    appName,
    events: [],
    done: false,
    startedAt: now,
    updatedAt: now,
    runtimeOwner: CURRENT_RUNTIME_OWNER ?? undefined,
    abortController,
  };
  persist(install);
  activeInstalls.set(appId, install);
  return abortController;
}

export function trackEvent(appId: string, event: InstallEvent): void {
  const install = load(appId);
  if (!install) throw new Error(`No durable install operation exists for ${appId}`);
  const safeEvent = sanitiseInstallEvent(event);
  const existingIdx = install.events.findIndex((candidate) => candidate.step === event.step && candidate.status === 'running');
  if (existingIdx >= 0 && event.status !== 'running') {
    install.events[existingIdx] = safeEvent;
  } else {
    install.events.push(safeEvent);
  }
  install.updatedAt = Date.now();
  activeInstalls.set(appId, install);
  persist(install);
}

export function finishTracking(appId: string, error?: string): void {
  const install = load(appId);
  if (!install) throw new Error(`No durable install operation exists for ${appId}`);
  install.done = true;
  install.error = error
    ? 'Installation failed; use the supported Health and repair views for sensitivity-safe details.'
    : undefined;
  install.updatedAt = Date.now();
  delete install.abortController;
  activeInstalls.set(appId, install);
  persist(install);
}

export function cancelInstall(appId: string): boolean {
  const install = load(appId);
  if (!install || install.done) return false;
  install.cancelled = true;
  install.updatedAt = Date.now();
  persist(install);
  install.abortController?.abort();
  return true;
}

export function getTrackedInstall(appId: string): Omit<TrackedInstall, 'abortController'> | undefined {
  const install = load(appId);
  return install ? serialisable(install) : undefined;
}

export function getAllActiveInstalls(): Omit<TrackedInstall, 'abortController'>[] {
  ensureDirectory();
  const records = new Map<string, TrackedInstall>();
  for (const [appId, install] of activeInstalls) records.set(appId, install);
  for (const entry of readdirSync(OPERATIONS_DIR)) {
    if (!entry.endsWith('.json')) continue;
    const appId = entry.slice(0, -5);
    if (!records.has(appId)) records.set(appId, readPersisted(appId)!);
  }
  return [...records.values()].filter((install) => !install.done).map(serialisable);
}

export function isInstalling(appId: string): boolean {
  const install = load(appId);
  return install !== undefined && !install.done;
}

export function recoverInterruptedInstalls(): string[] {
  ensureDirectory();
  const recovered: string[] = [];
  for (const entry of readdirSync(OPERATIONS_DIR)) {
    if (!entry.endsWith('.json')) continue;
    const appId = entry.slice(0, -5);
    const install = readPersisted(appId)!;
    if (install.done || activeInstalls.has(appId) || isRuntimeOwnerAlive(install.runtimeOwner)) continue;
    install.done = true;
    install.error = 'Control Panel restarted before the operation reached a terminal state; network reconciliation owns recovery.';
    install.updatedAt = Date.now();
    persist(install);
    recovered.push(appId);
  }
  return recovered;
}

export function reconcileCompletedInstallOperation(appId: string): boolean {
  const install = load(appId);
  if (!install || (!install.error && install.done)) return false;
  install.done = true;
  install.error = undefined;
  install.cancelled = false;
  install.updatedAt = Date.now();
  delete install.abortController;
  activeInstalls.set(appId, install);
  persist(install);
  return true;
}

export function pruneCompletedInstallOperations(maxAgeMs = 24 * 60 * 60_000): number {
  ensureDirectory();
  let removed = 0;
  const now = Date.now();
  for (const entry of readdirSync(OPERATIONS_DIR)) {
    if (!entry.endsWith('.json')) continue;
    const appId = entry.slice(0, -5);
    const install = readPersisted(appId)!;
    if (!install.done || now - install.updatedAt < maxAgeMs) continue;
    const file = operationPath(appId);
    if (statSync(file).isFile()) unlinkSync(file);
    fsyncDirectory();
    activeInstalls.delete(appId);
    removed++;
  }
  return removed;
}
