/**
 * Background Update Queue
 *
 * Persistent queue backed by PostgreSQL. Updates are enqueued via
 * enqueueUpdate() and processed one at a time by a background worker.
 *
 * The worker starts on module import (production only) and polls every 2s.
 * Updates run to completion regardless of client connections — fire and forget.
 */

import { execShell } from '@/lib/incus/server';
import { POSTGRES_MANIFEST } from '@/lib/apps/manifest';
import { getAppDefinition } from '@/lib/apps/definitions';
import { updateOCIApp, type UpdateEvent } from '@/lib/apps/updater';
import { updateLXDApp } from '@/lib/apps/lxd-updater';
import { updateMarketplaceApp } from '@/lib/market/updater';
import { getInstalledApp } from '@/lib/market/installed-apps';
import { spineClient } from '@/lib/spine/client';

const CONTAINER = POSTGRES_MANIFEST.containerName;

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

/* ── DB helpers ── */

async function psqlExec(sql: string): Promise<string> {
  const escaped = sql.replace(/'/g, "'\\''");
  const { exitCode, stdout, stderr } = await execShell(
    CONTAINER,
    `su - postgres -c "psql -U youeye -d youeye --csv -c '${escaped}'"`,
    { timeout: 15000 }
  );
  if (exitCode !== 0) throw new Error(`psql error: ${stderr}`);
  return stdout;
}

let tableEnsured = false;
async function ensureTable(): Promise<void> {
  if (tableEnsured) return;
  await psqlExec(`
    CREATE TABLE IF NOT EXISTS update_queue (
      id             SERIAL PRIMARY KEY,
      component      TEXT NOT NULL,
      status         TEXT NOT NULL DEFAULT 'pending',
      progress       INTEGER DEFAULT 0,
      message        TEXT DEFAULT '',
      error          TEXT,
      version_before TEXT,
      version_after  TEXT,
      requested_by   TEXT,
      requested_at   TIMESTAMPTZ DEFAULT NOW(),
      started_at     TIMESTAMPTZ,
      completed_at   TIMESTAMPTZ
    )
  `);
  tableEnsured = true;
}

function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { current += '"'; i++; }
      else if (ch === '"') { inQuotes = false; }
      else { current += ch; }
    } else {
      if (ch === '"') { inQuotes = true; }
      else if (ch === ',') { fields.push(current); current = ''; }
      else { current += ch; }
    }
  }
  fields.push(current);
  return fields;
}

function rowToEntry(fields: string[]): QueueEntry {
  return {
    id: parseInt(fields[0], 10),
    component: fields[1],
    status: fields[2] as QueueEntry['status'],
    progress: parseInt(fields[3] || '0', 10),
    message: fields[4] || '',
    error: fields[5] || null,
    version_before: fields[6] || null,
    version_after: fields[7] || null,
    requested_by: fields[8] || null,
    requested_at: fields[9] || '',
    started_at: fields[10] || null,
    completed_at: fields[11] || null,
  };
}

async function queryEntries(where: string): Promise<QueueEntry[]> {
  await ensureTable();
  const stdout = await psqlExec(
    `SELECT id, component, status, progress, message, error, version_before, version_after, requested_by, requested_at::text, started_at::text, completed_at::text FROM update_queue WHERE ${where} ORDER BY requested_at ASC`
  );
  const lines = stdout.trim().split('\n').filter(l => l.length > 0);
  if (lines.length < 2) return [];
  return lines.slice(1).map(l => rowToEntry(parseCSVLine(l)));
}

/* ── Public API ── */

/**
 * Enqueue an update. Returns existing entry if component already pending/running.
 */
export async function enqueueUpdate(
  component: string,
  requestedBy?: string,
): Promise<{ entry: QueueEntry; alreadyQueued: boolean }> {
  await ensureTable();

  // Check for existing pending/running entry
  const existing = await queryEntries(
    `component = '${component}' AND status IN ('pending', 'running')`
  );
  if (existing.length > 0) {
    return { entry: existing[0], alreadyQueued: true };
  }

  const user = requestedBy ? `'${requestedBy.replace(/'/g, "''")}'` : 'NULL';
  await psqlExec(
    `INSERT INTO update_queue (component, status, message, requested_by) VALUES ('${component}', 'pending', 'Queued for update', ${user})`
  );

  const entries = await queryEntries(
    `component = '${component}' AND status = 'pending'`
  );
  return { entry: entries[0], alreadyQueued: false };
}

/**
 * Get all active queue entries (pending + running + recently completed/failed).
 */
export async function getQueueStatus(): Promise<QueueEntry[]> {
  await ensureTable();
  // Active items + items completed/failed in the last 5 minutes
  return queryEntries(
    `status IN ('pending', 'running') OR (status IN ('completed', 'failed') AND completed_at > NOW() - INTERVAL '5 minutes')`
  );
}

/**
 * Get queue position for a component (0 = running, 1+ = waiting).
 */
export async function getQueuePosition(component: string): Promise<number> {
  const pending = await queryEntries(`status IN ('pending', 'running') ORDER BY requested_at ASC`);
  const idx = pending.findIndex(e => e.component === component);
  return idx;
}

/**
 * Clear completed/failed entries older than the given age.
 */
export async function clearOldEntries(maxAgeMinutes = 60): Promise<void> {
  await ensureTable();
  await psqlExec(
    `DELETE FROM update_queue WHERE status IN ('completed', 'failed') AND completed_at < NOW() - INTERVAL '${maxAgeMinutes} minutes'`
  );
}

/**
 * Acknowledge (dismiss) a completed/failed entry.
 */
export async function acknowledgeEntry(id: number): Promise<void> {
  await ensureTable();
  await psqlExec(`DELETE FROM update_queue WHERE id = ${id} AND status IN ('completed', 'failed')`);
}

/* ── Internal: update a queue row ── */

async function updateRow(
  id: number,
  fields: Partial<Pick<QueueEntry, 'status' | 'progress' | 'message' | 'error' | 'version_before' | 'version_after' | 'started_at' | 'completed_at'>>,
): Promise<void> {
  const sets: string[] = [];
  if (fields.status !== undefined) sets.push(`status = '${fields.status}'`);
  if (fields.progress !== undefined) sets.push(`progress = ${fields.progress}`);
  if (fields.message !== undefined) sets.push(`message = '${fields.message.replace(/'/g, "''")}'`);
  if (fields.error !== undefined) sets.push(`error = '${(fields.error || '').replace(/'/g, "''")}'`);
  if (fields.version_before !== undefined) sets.push(`version_before = '${fields.version_before}'`);
  if (fields.version_after !== undefined) sets.push(`version_after = '${fields.version_after}'`);
  if (fields.started_at !== undefined) sets.push(`started_at = '${fields.started_at}'`);
  if (fields.completed_at !== undefined) sets.push(`completed_at = '${fields.completed_at}'`);
  if (sets.length === 0) return;
  await psqlExec(`UPDATE update_queue SET ${sets.join(', ')} WHERE id = ${id}`);
}

/* ── Worker ── */

let workerRunning = false;
let workerTimer: ReturnType<typeof setInterval> | null = null;

async function processNextItem(): Promise<void> {
  if (workerRunning) return;

  const pending = await queryEntries(`status = 'pending'`);
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

  // Create an emit function that writes progress to the queue row
  const emit = (event: UpdateEvent) => {
    updateRow(id, {
      progress: event.progress ?? 0,
      message: event.message,
      ...(event.stage === 'completed' ? { status: 'completed', completed_at: new Date().toISOString() } : {}),
      ...(event.stage === 'failed' ? { status: 'failed', error: event.error || event.message, completed_at: new Date().toISOString() } : {}),
    }).catch(() => {});
  };

  // Check static app definitions first
  const appDef = getAppDefinition(component);

  if (appDef) {
    if (appDef.updatedBy === 'spine') {
      // Spine-managed components
      await runSpineUpdate(component, id, emit);
    } else if (appDef.type === 'lxd') {
      await updateLXDApp(appDef, emit);
    } else {
      await updateOCIApp(appDef, emit);
    }
    return;
  }

  // Check marketplace-installed apps
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
  queueId: number,
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
    await ensureTable();
    // Any "running" entries from before this process started are stale (crashed mid-update)
    await psqlExec(
      `UPDATE update_queue SET status = 'failed', error = 'Process restarted during update', completed_at = NOW() WHERE status = 'running'`
    );
    // Clean up old completed/failed entries (> 1 hour)
    await clearOldEntries(60);
  } catch (err) {
    console.error('[update-queue] Recovery failed:', err);
  }
}

/* ── Start/Stop ── */

export function startWorker(): void {
  if (workerTimer) return;

  // Recover stale entries on startup (after short delay for DB readiness)
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
