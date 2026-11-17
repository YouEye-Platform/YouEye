/**
 * Provisioning steps: each has its own persisted state, reason and times in
 * youeye.yaml (`setup_steps`, `setup_step_errors`, `setup_step_times`), and
 * independent steps run side by side.
 */
import { nextSetupStepErrors, setupStepReason, type SetupStepErrors } from './step-reason';

export type StepState = 'pending' | 'done' | 'error';
type StepTimes = Record<string, { startedAt?: string; finishedAt?: string }>;

export interface SetupConfigAccess {
  read(): Promise<Record<string, unknown>>;
  patch(patch: Record<string, unknown>): Promise<unknown>;
}

export type SetupStepStore = ReturnType<typeof setupStepStore>;

/**
 * Each write replaces whole youeye.yaml blocks, so writes from steps running
 * side by side go one at a time: none loses another's state.
 */
export function setupStepStore(config: SetupConfigAccess, now: () => Date = () => new Date()) {
  let tail: Promise<void> = Promise.resolve();
  const serial = (work: () => Promise<void>) => {
    const run = tail.then(work);
    tail = run.catch(() => undefined);
    return run;
  };
  const times = (raw: Record<string, unknown>): StepTimes => ({ ...(raw.setup_step_times as StepTimes || {}) });
  return {
    started: (stepId: string) => serial(async () => {
      const next = times(await config.read());
      next[stepId] = { startedAt: now().toISOString() };
      await config.patch({ setup_step_times: next });
    }),
    /** A failed step may carry a short, sanitized reason; any other state clears it. */
    save: (stepId: string, state: StepState, reason?: string) => serial(async () => {
      const raw = await config.read();
      const steps = { ...(raw.setup_steps as Record<string, StepState> || {}), [stepId]: state };
      const currentErrors = raw.setup_step_errors as SetupStepErrors | undefined;
      const errors = nextSetupStepErrors(currentErrors || {}, stepId, state, reason);
      const nextTimes = times(raw);
      if (state !== 'pending') nextTimes[stepId] = { ...nextTimes[stepId], finishedAt: now().toISOString() };
      await config.patch({
        setup_steps: steps,
        setup_step_times: nextTimes,
        ...(errors || currentErrors ? { setup_step_errors: errors } : {}),
      });
    }),
  };
}

/** A step failure whose wizard message differs from its persisted reason. */
export class StepFailure extends Error {
  constructor(message: string, readonly reason: string) {
    super(message);
    this.name = 'StepFailure';
  }
}

export interface SetupStepContext {
  store: SetupStepStore;
  /** False for a step already done (or another step in retry mode). */
  shouldRun(stepId: string): boolean;
  /** Renew the single-writer setup lease. */
  heartbeat(): Promise<void>;
  report(stepId: string, status: 'running' | 'done' | 'error', message?: string): void;
  log?(stepId: string, error: unknown): void;
}

export type SetupStepWork = () => Promise<string>;

/** Run one step with its own record, times and error. A failure never throws. */
export async function runSetupStep(context: SetupStepContext, stepId: string, work: SetupStepWork): Promise<boolean> {
  if (!context.shouldRun(stepId)) {
    context.report(stepId, 'done', 'Already completed');
    return true;
  }
  try {
    await context.heartbeat();
    context.report(stepId, 'running');
    await context.store.started(stepId);
    const message = await work();
    await context.store.save(stepId, 'done');
    context.report(stepId, 'done', message);
    return true;
  } catch (error) {
    const reason = error instanceof StepFailure ? error.reason : setupStepReason(error);
    context.log?.(stepId, error);
    await context.store.save(stepId, 'error', reason).catch(() => undefined);
    context.report(stepId, 'error', error instanceof Error ? error.message : reason);
    return false;
  }
}

/**
 * Run independent steps at the same time and wait for all of them; one
 * failure does not stop the others. The setup lease is renewed meanwhile
 * (a certificate wait can outlast it). True when every step succeeded.
 */
export async function runSetupStepsTogether(
  context: SetupStepContext,
  steps: ReadonlyArray<readonly [string, SetupStepWork]>,
  heartbeatEveryMs = 60_000,
): Promise<boolean> {
  const keepLease = setInterval(() => { void context.heartbeat().catch(() => undefined); }, heartbeatEveryMs);
  try {
    const results = await Promise.all(steps.map(([stepId, work]) => runSetupStep(context, stepId, work)));
    return results.every(Boolean);
  } finally {
    clearInterval(keepLease);
  }
}
