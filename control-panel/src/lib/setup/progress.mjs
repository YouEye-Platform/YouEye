/** @typedef {'pending' | 'running' | 'done' | 'error'} StepStatus */
/** @typedef {{step?: string, status?: StepStatus, message?: string, error?: string, complete?: boolean, hasErrors?: boolean}} SetupEvent */
/** @typedef {{failed: string, unknown: string}} Messages */
/** @typedef {{messages: Messages, onEvent?: (event: SetupEvent) => void, onChecking?: (checking: boolean) => void, fetchStatus?: (url: string, init?: RequestInit) => Promise<Response>, wait?: (ms: number) => Promise<void>, now?: () => number, timeoutMs?: number, pollMs?: number}} ProgressOptions */

const stepIds = new Set(['config', 'caddy', 'dns', 'ai', 'sso_control', 'sso_ui', 'finalize']);
const stepStates = new Set(['pending', 'running', 'done', 'error']);

/** Completion requires the existing durable operation to have settled too.
 * @param {{setup_completed?: unknown, setup_steps?: unknown}} config
 * @param {{setupCompleted: boolean}} claim
 * @param {boolean} retainedOperation
 */
export function setupProgressStatus(config, claim, retainedOperation) {
  const raw = config.setup_steps === undefined ? {} : config.setup_steps;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof retainedOperation !== 'boolean') {
    throw new Error('Setup progress is unavailable');
  }
  /** @type {Record<string, StepStatus>} */
  const steps = {};
  for (const [id, state] of Object.entries(raw)) {
    if (!stepIds.has(id) || !stepStates.has(state)) throw new Error('Setup progress is unavailable');
    steps[id] = state;
  }
  const state = Object.values(steps).includes('error') ? 'error'
    : config.setup_completed === true && claim.setupCompleted === true && !retainedOperation
      && Object.values(steps).every(step => step === 'done') ? 'complete' : 'pending';
  return { state, steps };
}

export class SetupProgressError extends Error {
  /** @param {string} message @param {boolean} readOnly */
  constructor(message, readOnly) {
    super(message);
    this.readOnly = readOnly;
  }
}

/** Reconnect only to retained status. Never repeat the setup submission.
 * @param {ProgressOptions} options
 */
export async function readSetupProgress(options) {
  const { messages, onEvent, onChecking } = options;
  const fetchStatus = options.fetchStatus ?? fetch;
  const wait = options.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const deadline = now() + (options.timeoutMs ?? 60_000);
  onChecking?.(true);
  try {
    while (now() < deadline) {
      try {
        const response = await fetchStatus('/api/setup/status', {
          cache: 'no-store', signal: AbortSignal.timeout(Math.max(1, Math.min(5_000, deadline - now()))),
        });
        if (response.status === 401 || response.status === 403) throw new SetupProgressError(messages.unknown, true);
        if (response.ok) {
          const status = await response.json();
          if (!status || !['pending', 'complete', 'error'].includes(status.state)
            || !status.steps || typeof status.steps !== 'object' || Array.isArray(status.steps)
            || Object.entries(status.steps).some(([id, state]) => !stepIds.has(id) || !stepStates.has(state))) {
            throw new Error('Invalid setup status');
          }
          for (const [step, state] of Object.entries(status.steps)) onEvent?.({ step, status: state });
          if (status.state === 'error' || Object.values(status.steps).includes('error')) {
            throw new SetupProgressError(messages.failed, false);
          }
          if (status.state === 'complete' && Object.values(status.steps).every(step => step === 'done')) return;
        }
      } catch (error) {
        if (error instanceof SetupProgressError) throw error;
        // A Control Panel restart can briefly make the status reader unavailable.
      }
      await wait(Math.min(options.pollMs ?? 1_000, Math.max(0, deadline - now())));
    }
    throw new SetupProgressError(messages.unknown, true);
  } finally {
    onChecking?.(false);
  }
}

/** Follow one accepted setup request, reconciling a lost stream through GET.
 * @param {() => Promise<Response>} submit
 * @param {ProgressOptions} options
 */
export async function followSetupProgress(submit, options) {
  let response;
  try { response = await submit(); }
  catch { return readSetupProgress(options); }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    let message = text || options.messages.failed;
    try { message = JSON.parse(text).error || message; } catch { /* Preserve the server response. */ }
    throw new SetupProgressError(message, false);
  }
  const reader = response.body?.getReader();
  if (!reader) return readSetupProgress(options);
  const decoder = new TextDecoder();
  let buffer = '';
  let failure = '';
  let complete = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data: ') || line.slice(6).trim() === '[DONE]') continue;
        /** @type {SetupEvent} */
        let event;
        try { event = JSON.parse(line.slice(6)); } catch { continue; }
        if (!event || typeof event !== 'object') continue;
        if (event.status === 'error') failure ||= event.message || options.messages.failed;
        if (event.error) failure = event.error;
        if (event.hasErrors) failure ||= options.messages.failed;
        options.onEvent?.(event);
        if (event.complete === true && !failure) { complete = true; break; }
      }
      if (complete) break;
    }
  } catch {
    // Transport failure is not evidence that retained setup work failed.
  } finally {
    reader.releaseLock();
  }
  if (failure) throw new SetupProgressError(failure, false);
  if (complete) return;
  return readSetupProgress(options);
}
