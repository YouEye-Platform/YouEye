/**
 * Background Update Queue
 *
 * Persistent queue backed by a JSON file at
 * /var/lib/youeye/state/update-queue.json. Updates are enqueued via
 * enqueueUpdate() and processed one at a time by a background worker.
 *
 * The worker starts on module import (production only) and polls every 2s.
 * Updates run to completion regardless of client connections — fire and forget.
 */

import { readJSON, writeJSON, statePath } from '@/lib/storage/json-store';
import { getAppDefinition } from '@/lib/apps/definitions';
import { updateOCIApp, type UpdateEvent } from '@/lib/apps/updater';
import { updateLXDApp } from '@/lib/apps/lxd-updater';
import { updateMarketplaceApp } from '@/lib/market/updater';
import { getInstalledApp } from '@/lib/market/installed-apps';
import { spineClient } from '@/lib/spine/client';

const STORE_PATH = statePath('update-queue.json');

/* ── Types ── */

export interface QueueEntry {
  id: number;
  component: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  progress: number;
  message: string;
  error: string | null;
  version_before: string | null;
  version_after: string | null;
  requested_by: string | null;
  requested_at: string;
  started_at: string | null;
  completed_at: string | null;
}

interface UpdateQueueStore {
  entries: QueueEntry[];
  nextId: number;
}

/* ── Store Management ── */

let store: UpdateQueueStore | null = null;

async function loadStore(): Promise<UpdateQueueStore> {
  if (store) return store;
  store = await readJSON<UpdateQueueStore>(STORE_PATH) ?? { entries: [], nextId: 1 };
  return store;
}

async function saveStore(): Promise<void> {
  if (!store) return;
  await writeJSON(STORE_PATH, store);
}

/* ── Internal helpers ── */

function findEntry(s: UpdateQueueStore, id: number): QueueEntry | undefined {
  return s.entries.find(e => e.id === id);
}

async function updateRow(
  id: number,
  fields: Partial<Pick<QueueEntry, 'status' | 'progress' | 'message' | 'error' | 'version_before' | 'version_after' | 'started_at' | 'completed_at'>>,
): Promise<void> {
  const s = await loadStore();
  const entry = findEntry(s, id);
  if (!entry) return;
  Object.assign(entry, fields);
  await saveStore();
}

/* ── Public API ── */

export async function enqueueUpdate(
  component: string,
  requestedBy?: string,
): Promise<{ entry: QueueEntry; alreadyQueued: boolean }> {
  const s = await loadStore();

  const existing = s.entries.find(
    e => e.component === component && (e.status === 'pending' || e.status === 'running')
  );
  if (existing) {
    return { entry: existing, alreadyQueued: true };
  }

  const entry: QueueEntry = {
    id: s.nextId++,
    component,
    status: 'pending',
    progress: 0,
    message: 'Queued for update',
    error: null,
    version_before: null,
    version_after: null,
    requested_by: requestedBy ?? null,
    requested_at: new Date().toISOString(),
    started_at: null,
    completed_at: null,
  };
  s.entries.push(entry);
  await saveStore();

  return { entry, alreadyQueued: false };
}

export async function getQueueStatus(): Promise<QueueEntry[]> {
  const s = await loadStore();
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  return s.entries
    .filter(e =>
      e.status === 'pending' || e.status === 'running' ||
      ((e.status === 'completed' || e.status === 'failed') && e.completed_at && e.completed_at > fiveMinAgo)
    )
    .sort((a, b) => a.requested_at.localeCompare(b.requested_at));
}

export async function getQueuePosition(component: string): Promise<number> {
  const s = await loadStore();
  const active = s.entries
    .filter(e => e.status === 'pending' || e.status === 'running')
    .sort((a, b) => a.requested_at.localeCompare(b.requested_at));
  return active.findIndex(e => e.component === component);
}

export async function clearOldEntries(maxAgeMinutes = 60): Promise<void> {
  const s = await loadStore();
  const cutoff = new Date(Date.now() - maxAgeMinutes * 60 * 1000).toISOString();
  const before = s.entries.length;
  s.entries = s.entries.filter(e =>
    !(
      (e.status === 'completed' || e.status === 'failed') &&
      e.completed_at && e.completed_at < cutoff
    )
  );
  if (s.entries.length !== before) {
    await saveStore();
  }
}

export async function acknowledgeEntry(id: number): Promise<void> {
  const s = await loadStore();
  const idx = s.entries.findIndex(
    e => e.id === id && (e.status === 'completed' || e.status === 'failed')
  );
  if (idx !== -1) {
    s.entries.splice(idx, 1);
    await saveStore();
  }
}

/* ── Worker ── */

let workerRunning = false;
let workerTimer: ReturnType<typeof setInterval> | null = null;

async function processNextItem(): Promise<void> {
  if (workerRunning) return;

  const s = await loadStore();
  const pending = s.entries
    .filter(e => e.status === 'pending')
    .sort((a, b) => a.requested_at.localeCompare(b.requested_at));
  if (pending.length === 0) return;

  const entry = pending[0];
  workerRunning = true;

  try {
    await updateRow(entry.id, {
      status: 'running',
      progress: 0,
      message: `Starting update for ${entry.component}`,
      started_at: new Date().toISOString(),
    });

    await runUpdate(entry);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    try {
      await updateRow(entry.id, {
        status: 'failed',
        progress: 0,
        message: 'Update failed',
        error: errMsg,
        completed_at: new Date().toISOString(),
      });
    } catch { /* best effort */ }
  } finally {
    workerRunning = false;
  }
}

async function runUpdate(entry: QueueEntry): Promise<void> {
  const { id, component } = entry;

  const emit = (event: UpdateEvent) => {
    updateRow(id, {
      progress: event.progress ?? 0,
      message: event.message,
      ...(event.stage === 'completed' ? { status: 'completed', completed_at: new Date().toISOString() } : {}),
      ...(event.stage === 'failed' ? { status: 'failed', error: event.error || event.message, completed_at: new Date().toISOString() } : {}),
    }).catch(() => {});
  };

  const appDef = getAppDefinition(component);

  if (appDef) {
    if (appDef.updatedBy === 'spine') {
      await runSpineUpdate(component, emit);
    } else if (appDef.type === 'lxd') {
      await updateLXDApp(appDef, emit);
    } else {
      await updateOCIApp(appDef, emit);
    }
    return;
  }

  const installed = await getInstalledApp(component);
  if (installed) {
    const result = await updateMarketplaceApp(
      { appId: component },
      (event) => {
        emit({
          stage: event.status === 'running' ? 'rebuilding'
            : event.status === 'success' ? 'completed'
            : event.status === 'error' ? 'failed'
            : 'starting',
          message: event.message,
          progress: Math.round((event.step / event.totalSteps) * 100),
          ...(event.status === 'error' ? { error: event.message } : {}),
        });
      }
    );
    if (!result.success) {
      throw new Error(result.error || 'Marketplace update failed');
    }
    return;
  }

  throw new Error(`Unknown component: ${component}`);
}

async function runSpineUpdate(
  component: string,
  emit: (event: UpdateEvent) => void,
): Promise<void> {
  emit({ stage: 'starting', message: 'Starting update via Spine', progress: 10 });

  let result;
  switch (component) {
    case 'spine':
      result = await spineClient.updateSelf();
      break;
    case 'control-panel':
      result = await spineClient.updateControl();
      break;
    case 'incus':
      result = await spineClient.updateIncus();
      break;
    case 'host-system':
      result = await spineClient.updateSystem();
      break;
    default:
      throw new Error(`No Spine update handler for ${component}`);
  }

  if (result.status === 'success' || result.status === 'updated' || result.status === 'no_update') {
    emit({ stage: 'completed', message: result.message || 'Update completed', progress: 100 });
  } else {
    throw new Error(result.message || 'Spine update failed');
  }
}

/* ── Startup recovery ── */

async function recoverStaleEntries(): Promise<void> {
  try {
    const s = await loadStore();
    let changed = false;
    for (const entry of s.entries) {
      if (entry.status === 'running') {
        entry.status = 'failed';
        entry.error = 'Process restarted during update';
        entry.completed_at = new Date().toISOString();
        changed = true;
      }
    }
    if (changed) await saveStore();
    await clearOldEntries(60);
  } catch (err) {
    console.error('[update-queue] Recovery failed:', err);
  }
}

/* ── Start/Stop ── */

export function startWorker(): void {
  if (workerTimer) return;

  setTimeout(() => {
    recoverStaleEntries().then(() => {
      console.log('[update-queue] Worker started, polling every 2s');
    }).catch(err => {
      console.error('[update-queue] Recovery error:', err);
    });
  }, 5000);

  workerTimer = setInterval(() => {
    processNextItem().catch(err => {
      console.error('[update-queue] Worker error:', err);
      workerRunning = false;
    });
  }, 2000);
}

export function stopWorker(): void {
  if (workerTimer) {
    clearInterval(workerTimer);
    workerTimer = null;
  }
}

// Auto-start in production
if (typeof process !== 'undefined' && process.env.NODE_ENV !== 'test') {
  startWorker();
}
