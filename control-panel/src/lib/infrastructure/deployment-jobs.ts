import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

import { sanitizeDeploymentDetail } from './deployment-safety';
import type {
  DeploymentEvent,
  DeploymentJobKind,
  DeploymentJobState,
} from './types';

const DEFAULT_STATE_DIR = '/var/lib/youeye/control/deployments';
const MAX_EVENTS = 128;
const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;

export type DeploymentRunner = (
  hostIP: string,
  onEvent: (event: DeploymentEvent) => void,
) => Promise<void>;

type Subscriber = (state: DeploymentJobState) => void;

interface RuntimeJob {
  state: DeploymentJobState;
  writeChain: Promise<void>;
  promise: Promise<void>;
}

interface DeploymentRegistry {
  active: Map<string, RuntimeJob>;
  starting: Map<string, Promise<DeploymentJobState>>;
  subscribers: Map<string, Set<Subscriber>>;
}

const globalRegistry = globalThis as typeof globalThis & {
  __youeyeInfrastructureDeploymentJobs?: DeploymentRegistry;
};

const registry: DeploymentRegistry = globalRegistry.__youeyeInfrastructureDeploymentJobs ?? {
  active: new Map(),
  starting: new Map(),
  subscribers: new Map(),
};
globalRegistry.__youeyeInfrastructureDeploymentJobs = registry;

function stateDir(): string {
  return process.env.YOUEYE_DEPLOYMENT_STATE_DIR || DEFAULT_STATE_DIR;
}

export function validateDeploymentID(id: string): string {
  if (!JOB_ID_PATTERN.test(id)) {
    throw new Error('deployment_id must be 8-128 URL-safe characters');
  }
  return id;
}

export function newDeploymentID(kind: DeploymentJobKind): string {
  return `${kind}-${randomUUID()}`;
}

function statePath(id: string): string {
  return join(stateDir(), `${validateDeploymentID(id)}.json`);
}

function cloneState(state: DeploymentJobState): DeploymentJobState {
  return structuredClone(state);
}

async function persistState(state: DeploymentJobState): Promise<void> {
  const dir = stateDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);

  const destination = statePath(state.id);
  const temporary = join(dir, `.${state.id}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, destination);
  await chmod(destination, 0o600);
}

function notify(state: DeploymentJobState): void {
  for (const subscriber of registry.subscribers.get(state.id) ?? []) {
    try {
      subscriber(cloneState(state));
    } catch {
      // A progress consumer is disposable; the job and durable state are not.
    }
  }
}

function queuePersist(runtime: RuntimeJob): void {
  const snapshot = cloneState(runtime.state);
  runtime.writeChain = runtime.writeChain.then(() => persistState(snapshot));
  notify(runtime.state);
}

function appendEvent(runtime: RuntimeJob, event: DeploymentEvent): void {
  const sequence = (runtime.state.events.at(-1)?.sequence ?? 0) + 1;
  runtime.state.events.push({
    ...event,
    detail: event.detail ? sanitizeDeploymentDetail(event.detail) : undefined,
    deploymentId: runtime.state.id,
    sequence,
  });
  if (runtime.state.events.length > MAX_EVENTS) {
    runtime.state.events.splice(0, runtime.state.events.length - MAX_EVENTS);
  }
  runtime.state.updatedAt = new Date().toISOString();
  queuePersist(runtime);
}

function terminalEvent(
  runtime: RuntimeJob,
  status: 'success' | 'error',
  message: string,
  detail?: string,
): DeploymentEvent {
  const last = runtime.state.events.at(-1);
  return {
    step: last?.step || 0,
    totalSteps: last?.totalSteps || (runtime.state.kind === 'deploy' ? 4 : 5),
    status,
    message,
    detail,
    terminal: true,
  };
}

async function readPersistedState(id: string): Promise<DeploymentJobState | null> {
  try {
    const parsed = JSON.parse(await readFile(statePath(id), 'utf8')) as DeploymentJobState;
    return parsed;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    throw error;
  }
}

function markIndeterminate(state: DeploymentJobState): DeploymentJobState {
  if (state.status !== 'running') return state;
  const active = registry.active.get(state.id);
  if (state.ownerPID === process.pid && active) return state;
  return {
    ...state,
    status: 'indeterminate',
    updatedAt: new Date().toISOString(),
    failure: {
      step: state.events.at(-1)?.step ?? 0,
      message: 'Deployment worker ownership was lost before a terminal result was recorded',
      detail: 'Run infrastructure reconciliation before finalising the installation.',
    },
  };
}

export async function getDeploymentJob(id: string): Promise<DeploymentJobState | null> {
  validateDeploymentID(id);
  const runtime = registry.active.get(id);
  if (runtime) return cloneState(runtime.state);

  const persisted = await readPersistedState(id);
  if (!persisted) return null;
  const reconciled = markIndeterminate(persisted);
  if (reconciled.status !== persisted.status) await persistState(reconciled);
  return reconciled;
}

async function startNewJob(
  id: string,
  kind: DeploymentJobKind,
  hostIP: string,
  runner: DeploymentRunner,
): Promise<DeploymentJobState> {
  const existing = await getDeploymentJob(id);
  if (existing) {
    if (existing.kind !== kind || existing.hostIP !== hostIP) {
      throw new Error('deployment_id is already bound to a different request');
    }
    return existing;
  }

  const conflicting = [...registry.active.values()].find((runtime) => runtime.state.status === 'running');
  if (conflicting) {
    throw new Error(`infrastructure ${conflicting.state.kind} job ${conflicting.state.id} is already running`);
  }

  const now = new Date().toISOString();
  const runtime: RuntimeJob = {
    state: {
      id,
      kind,
      hostIP,
      status: 'running',
      ownerPID: process.pid,
      createdAt: now,
      updatedAt: now,
      events: [],
    },
    writeChain: Promise.resolve(),
    promise: Promise.resolve(),
  };
  registry.active.set(id, runtime);
  try {
    await persistState(runtime.state);
  } catch (error) {
    registry.active.delete(id);
    throw error;
  }

  runtime.promise = (async () => {
    try {
      await runner(hostIP, (event) => appendEvent(runtime, event));
      await runtime.writeChain;

      const reportedFailure = [...runtime.state.events].reverse().find((event) => event.status === 'error');
      if (reportedFailure) {
        throw new Error(reportedFailure.detail || reportedFailure.message);
      }

      runtime.state.status = 'succeeded';
      runtime.state.completedAt = new Date().toISOString();
      appendEvent(runtime, terminalEvent(runtime, 'success',
        kind === 'deploy'
          ? 'Infrastructure deployment reached durable success'
          : 'Infrastructure reconciliation reached durable success'));
    } catch (error) {
      const lastFailure = [...runtime.state.events].reverse().find((event) => event.status === 'error');
      const detail = sanitizeDeploymentDetail(lastFailure?.detail || error);
      runtime.state.status = 'failed';
      runtime.state.failure = {
        step: lastFailure?.step ?? 0,
        message: lastFailure?.message || (kind === 'deploy'
          ? 'Infrastructure deployment failed'
          : 'Infrastructure reconciliation failed'),
        detail: detail || undefined,
      };
      runtime.state.completedAt = new Date().toISOString();
      appendEvent(runtime, terminalEvent(runtime, 'error', runtime.state.failure.message, detail));
    } finally {
      runtime.state.updatedAt = new Date().toISOString();
      try {
        // A prior queued write may have failed. Make one fresh terminal write
        // rather than chaining forever from a rejected promise, but always
        // release the runtime reservation if durable storage is unavailable.
        await runtime.writeChain.catch(() => undefined);
        await persistState(cloneState(runtime.state));
        notify(runtime.state);
      } catch (error) {
        console.error('[deployment-jobs] terminal state persistence failed:', sanitizeDeploymentDetail(error));
      } finally {
        registry.active.delete(id);
      }
    }
  })();

  return cloneState(runtime.state);
}

export async function startDeploymentJob(args: {
  id: string;
  kind: DeploymentJobKind;
  hostIP: string;
  runner: DeploymentRunner;
}): Promise<DeploymentJobState> {
  const id = validateDeploymentID(args.id);
  const inFlight = registry.starting.get(id);
  if (inFlight) return inFlight;

  const starting = startNewJob(id, args.kind, args.hostIP, args.runner)
    .finally(() => registry.starting.delete(id));
  registry.starting.set(id, starting);
  return starting;
}

export function subscribeDeploymentJob(id: string, subscriber: Subscriber): () => void {
  validateDeploymentID(id);
  const subscribers = registry.subscribers.get(id) ?? new Set<Subscriber>();
  subscribers.add(subscriber);
  registry.subscribers.set(id, subscribers);
  return () => {
    subscribers.delete(subscriber);
    if (subscribers.size === 0) registry.subscribers.delete(id);
  };
}

export function createDeploymentJobStream(id: string): ReadableStream<Uint8Array> {
  validateDeploymentID(id);
  const encoder = new TextEncoder();
  let cleanup = () => {};
  let cancelled = false;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      let cleaned = false;
      const seen = new Set<number>();
      let unsubscribe = () => {};
      const keepalive = setInterval(() => {
        if (!safeSend(': keepalive\n\n')) clearInterval(keepalive);
      }, 10_000);

      const cleanupNow = () => {
        if (cleaned) return;
        cleaned = true;
        clearInterval(keepalive);
        unsubscribe();
      };

      const safeSend = (payload: string): boolean => {
        if (closed) return false;
        try {
          controller.enqueue(encoder.encode(payload));
          return true;
        } catch {
          closed = true;
          cleanupNow();
          return false;
        }
      };
      const safeClose = () => {
        if (closed) return;
        closed = true;
        cleanupNow();
        try {
          controller.close();
        } catch {
          // The client may already have cancelled its request-owned stream.
        }
      };
      const emitState = (state: DeploymentJobState) => {
        for (const event of state.events) {
          const sequence = event.sequence ?? 0;
          if (seen.has(sequence)) continue;
          seen.add(sequence);
          if (!safeSend(`data: ${JSON.stringify(event)}\n\n`)) break;
        }
        if (state.status !== 'running') safeClose();
      };

      unsubscribe = subscribeDeploymentJob(id, emitState);
      cleanup = () => {
        closed = true;
        cleanupNow();
      };
      if (cancelled) {
        cleanup();
        return;
      }

      try {
        const initial = await getDeploymentJob(id);
        if (!initial) {
          safeSend(`data: ${JSON.stringify({
            step: 0,
            totalSteps: 0,
            status: 'error',
            message: 'Deployment job not found',
            deploymentId: id,
            terminal: true,
          })}\n\n`);
          safeClose();
          return;
        }
        emitState(initial);
      } catch (error) {
        safeSend(`data: ${JSON.stringify({
          step: 0,
          totalSteps: 0,
          status: 'error',
          message: 'Could not read deployment job state',
          detail: sanitizeDeploymentDetail(error),
          deploymentId: id,
          terminal: true,
        })}\n\n`);
        safeClose();
      }
    },
    cancel() {
      cancelled = true;
      cleanup();
    },
  });
}
