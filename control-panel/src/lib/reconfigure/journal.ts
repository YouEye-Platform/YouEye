import { mkdir, readFile, rename, writeFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

const JOURNAL = process.env.YOUEYE_RECONFIGURE_JOURNAL || '/var/lib/youeye/config/server-url-change.json';
export const processStartTime = Math.round(Date.now() - process.uptime() * 1000);

export interface ReconfigureJournal {
  oldDomain: string;
  oldIdentityOrigin: string;
  oldSubdomains: Record<string, string>;
  newDomain: string;
  newSubdomains: Record<string, string>;
  phase: 'applying' | 'restart-pending' | 'restart-scheduled';
  processStartedAt: number;
  scheduledAt?: number;
}

export async function readReconfigureJournal(): Promise<ReconfigureJournal | null> {
  let value: ReconfigureJournal;
  try { value = JSON.parse(await readFile(JOURNAL, 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (!value.oldDomain || !value.newDomain || !value.oldIdentityOrigin || !Number.isFinite(value.processStartedAt) || !value.oldSubdomains || !value.newSubdomains
    || !['applying', 'restart-pending', 'restart-scheduled'].includes(value.phase)) throw new Error('Invalid server URL change journal');
  // The persisted restart receipt is reconciled against the actual new process,
  // rather than a timer or a successful scheduling HTTP response.
  const identity = `https://${value.newSubdomains.identity}.${value.newDomain}`;
  const control = `https://${value.newSubdomains.control || 'control'}.${value.newDomain}`;
  if (value.phase !== 'applying' && value.processStartedAt !== processStartTime && process.env.IDENTITY_URL === identity
    && process.env.CONTROL_EXTERNAL_URL === control) {
    await rm(JOURNAL);
    return null;
  }
  // An acknowledged restart that never recovers must be retryable after its
  // bounded recovery window; never schedule overlapping restarts immediately.
  if (value.phase === 'restart-scheduled' && Date.now() - (value.scheduledAt || 0) > 30_000) {
    return { ...value, phase: 'applying' };
  }
  return value;
}

export async function saveReconfigureJournal(value: ReconfigureJournal): Promise<void> {
  await mkdir(dirname(JOURNAL), { recursive: true });
  await writeFile(`${JOURNAL}.tmp`, JSON.stringify(value), { mode: 0o600 });
  await rename(`${JOURNAL}.tmp`, JOURNAL);
}

/** Durable work first, one acknowledged delayed restart, then stream completion. */
export async function finishReconfigure(operations: {
  restart: boolean;
  beforeRestart?: () => Promise<void>;
  persist: () => Promise<void>;
  schedule: () => Promise<unknown>;
  scheduled: () => Promise<void>;
  failed: () => Promise<void>;
  complete: () => void;
}): Promise<void> {
  if (operations.beforeRestart) await operations.beforeRestart();
  if (operations.restart) {
    await operations.persist();
    try { await operations.schedule(); }
    catch (error) { await operations.failed(); throw error; }
    await operations.scheduled();
  }
  operations.complete();
}
