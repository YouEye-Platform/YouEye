/**
 * Update State Manager
 *
 * Persists update status in a local JSON file at
 * /var/lib/youeye/state/update-status.json.
 * Aggregates Spine status (from Spine API) with CP-managed updates.
 */

import { readJSON, writeJSON, statePath } from '@/lib/storage/json-store';
import { spineClient } from '@/lib/spine/client';

const STORE_PATH = statePath('update-status.json');

/** Known update components — allowlist prevents injection via component param */
const ALLOWED_COMPONENTS = new Set([
  'spine', 'control', 'ui', 'incus', 'system',
  'caddy', 'pihole', 'postgres', 'authentik', 'wiki', 'search',
]);

function validateComponent(component: string): void {
  if (!ALLOWED_COMPONENTS.has(component)) {
    throw new Error(`Invalid component: ${component}`);
  }
}

export interface UpdateStatusRecord {
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

async function loadStore(): Promise<UpdateStatusStore> {
  if (store) return store;
  store = await readJSON<UpdateStatusStore>(STORE_PATH) ?? { statuses: {} };
  return store;
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
  }
): Promise<void> {
  validateComponent(component);
  const s = await loadStore();
  const existing = s.statuses[component];

  s.statuses[component] = {
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
  const s = await loadStore();
  delete s.statuses[component];
  await saveStore();
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
    // Skip stale terminal statuses — same logic as Spine statuses below
    const isTerminal = s.status === 'completed' || s.status === 'failed';
    if (isTerminal && s.updated_at) {
      const age = Date.now() - new Date(s.updated_at).getTime();
      if (age > 60_000) continue;
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

export async function startUpdate(component: string, versionBefore: string): Promise<void> {
  await writeStatus(component, 'checking', 0, 'Checking for updates...', {
    versionBefore,
  });
}

export async function completeUpdate(component: string, versionBefore: string, versionAfter: string): Promise<void> {
  await writeStatus(component, 'completed', 100, 'Update completed successfully', {
    versionBefore,
    versionAfter,
  });
}

export async function failUpdate(component: string, versionBefore: string, errorMsg: string): Promise<void> {
  await writeStatus(component, 'failed', 0, 'Update failed', {
    versionBefore,
    error: errorMsg,
  });
}
