/**
 * Update State Manager
 *
 * Persists update status in a local JSON file at
 * /var/lib/youeye/state/update-status.json.
 * Aggregates Spine status (from Spine API) with CP-managed updates.
 */

import { readJSON, writeJSON, statePath } from '@/lib/storage/json-store';
import { SerializedExecutor } from '@/lib/storage/serialized-executor';
import { spineClient } from '@/lib/spine/client';
import { randomUUID } from 'crypto';

const STORE_PATH = statePath('update-status.json');

/** Validate component ID format — prevents path injection while allowing dynamic app IDs */
function validateComponent(component: string): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(component) || component.length > 64) {
    throw new Error(`Invalid component: ${component}`);
  }
}

export interface UpdateStatusRecord {
  attempt_id: string;
  authority: 'control-panel' | 'spine';
  component: string;
  status: string;
  progress: number;
  message: string;
  version_before: string | null;
  version_after: string | null;
  error: string | null;
  started_at: string | null;
  updated_at: string;
}

type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'downloading'
  | 'installing'
  | 'restarting'
  | 'verifying'
  | 'completed'
  | 'failed';

// ─── Store Management ─────────────────────────────────────────

interface UpdateStatusStore {
  statuses: Record<string, UpdateStatusRecord>;
}

let store: UpdateStatusStore | null = null;
let storeLoad: Promise<UpdateStatusStore> | null = null;
const mutations = new SerializedExecutor();

async function loadStore(): Promise<UpdateStatusStore> {
  if (store) return store;
  if (!storeLoad) {
    storeLoad = readJSON<UpdateStatusStore>(STORE_PATH).then((loaded) => {
      store = loaded ?? { statuses: {} };
      return store;
    });
  }
  return storeLoad;
}

async function saveStore(): Promise<void> {
  if (!store) return;
  await writeJSON(STORE_PATH, store);
}

// ─── Status Operations ────────────────────────────────────────

export async function writeStatus(
  component: string,
  status: UpdateStatus,
  progress: number,
  message: string,
  opts?: {
    versionBefore?: string;
    versionAfter?: string;
    error?: string;
    startedAt?: string;
    attemptId?: string;
    authority?: 'control-panel' | 'spine';
  }
): Promise<void> {
  validateComponent(component);
  await mutations.run(async () => {
    const s = await loadStore();
    const existing = s.statuses[component];

    s.statuses[component] = {
      attempt_id: opts?.attemptId ?? existing?.attempt_id ?? randomUUID(),
      authority: opts?.authority ?? existing?.authority ?? 'control-panel',
      component,
      status,
      progress,
      message,
      version_before: opts?.versionBefore ?? existing?.version_before ?? null,
      version_after: opts?.versionAfter ?? null,
      error: opts?.error ?? null,
      started_at: opts?.startedAt ?? existing?.started_at ?? new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    await saveStore();
  });
}

export async function readStatus(component: string): Promise<UpdateStatusRecord | null> {
  validateComponent(component);
  const s = await loadStore();
  return s.statuses[component] ?? null;
}

export async function readAllStatuses(): Promise<UpdateStatusRecord[]> {
  const s = await loadStore();
  return Object.values(s.statuses).sort(
    (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
  );
}

export async function clearStatus(component: string): Promise<void> {
  validateComponent(component);
  await mutations.run(async () => {
    const s = await loadStore();
    delete s.statuses[component];
    await saveStore();
  });
}

/**
 * Get a unified view of all update statuses — aggregating
 * Spine's status (via API) with CP-managed statuses (from JSON store).
 */
export async function getUnifiedStatuses(): Promise<UpdateStatusRecord[]> {
  const [dbStatuses, spineStatus] = await Promise.all([
    readAllStatuses().catch(() => [] as UpdateStatusRecord[]),
    spineClient.getUpdateStatus().catch(() => null),
  ]);

  const result = new Map<string, UpdateStatusRecord>();

  for (const s of dbStatuses) {
    const isTerminal = s.status === 'completed' || s.status === 'failed';
    if (s.updated_at) {
      const age = Date.now() - new Date(s.updated_at).getTime();
      // Prune terminal statuses after 60s
      if (isTerminal && age > 60_000) continue;
      // Prune non-terminal statuses after 5 minutes — they're stuck
      // (e.g. CP self-update writes "downloading" then dies mid-request)
      if (!isTerminal && age > 300_000) continue;
    }
    result.set(s.component, s);
  }

  // Overlay Spine's own status (source of truth for spine/control/ui updates via Spine)
  // Skip completed/failed statuses older than 60 seconds — they're stale
  if (spineStatus && spineStatus.status !== 'idle') {
    const isTerminal = spineStatus.status === 'completed' || spineStatus.status === 'failed';
    let isStale = false;
    if (isTerminal && spineStatus.updated_at) {
      const age = Date.now() - new Date(spineStatus.updated_at).getTime();
      isStale = age > 60_000;
    }

    if (!isStale) {
      const component = spineStatus.component || 'spine';
      result.set(component, {
        attempt_id: spineStatus.attempt_id || `spine-${spineStatus.started_at || spineStatus.updated_at}`,
        authority: 'spine',
        component,
        status: spineStatus.status,
        progress: spineStatus.progress || 0,
        message: spineStatus.message || '',
        version_before: spineStatus.version_before || null,
        version_after: spineStatus.version_after || null,
        error: spineStatus.error || null,
        started_at: spineStatus.started_at || null,
        updated_at: spineStatus.updated_at || new Date().toISOString(),
      });
    }
  }

  return Array.from(result.values());
}

export async function startUpdate(component: string, versionBefore: string): Promise<string> {
  const attemptId = randomUUID();
  await writeStatus(component, 'checking', 0, 'Checking for updates...', {
    versionBefore,
    attemptId,
    authority: 'control-panel',
  });
  return attemptId;
}

export async function completeUpdate(component: string, versionBefore: string, versionAfter: string): Promise<void> {
  await writeStatus(component, 'completed', 100, 'Update completed successfully', {
    versionBefore,
    versionAfter,
  });
}

export async function completeNoOp(component: string, version = ''): Promise<void> {
  await writeStatus(component, 'completed', 100, 'Already up to date', {
    versionBefore: version,
    versionAfter: version,
  });
}

export async function failUpdate(component: string, versionBefore: string, errorMsg: string): Promise<void> {
  await writeStatus(component, 'failed', 0, 'Update failed', {
    versionBefore,
    error: errorMsg,
  });
}
