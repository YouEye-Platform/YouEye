/**
 * Update State Manager
 *
 * Persists update status in PostgreSQL via psql (same pattern as postgres/client.ts).
 * Aggregates Spine status (from Spine API) with CP-managed updates (from DB).
 */

import { execShell } from '@/lib/incus/server';
import { POSTGRES_MANIFEST } from '@/lib/apps/manifest';
import { spineClient } from '@/lib/spine/client';

const CONTAINER = POSTGRES_MANIFEST.containerName;

/** Known update components — allowlist prevents SQL/shell injection via component param */
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

/**
 * Run a raw psql command (not read-only) inside the postgres container.
 */
async function psqlExec(sql: string): Promise<string> {
  const escaped = sql.replace(/'/g, "'\\''");
  const { exitCode, stdout, stderr } = await execShell(
    CONTAINER,
    `su - postgres -c "psql -U youeye -d youeye --csv -c '${escaped}'"`,
    { timeout: 15000 }
  );

  if (exitCode !== 0) {
    throw new Error(`psql error: ${stderr}`);
  }
  return stdout;
}

/**
 * Ensure the update_status table exists. Called once on first use.
 */
let tableEnsured = false;
async function ensureTable(): Promise<void> {
  if (tableEnsured) return;

  await psqlExec(`
    CREATE TABLE IF NOT EXISTS update_status (
      component    TEXT PRIMARY KEY,
      status       TEXT NOT NULL DEFAULT 'idle',
      progress     INTEGER DEFAULT 0,
      message      TEXT DEFAULT '',
      version_before TEXT,
      version_after  TEXT,
      error        TEXT,
      started_at   TIMESTAMP WITH TIME ZONE,
      updated_at   TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )
  `);
  tableEnsured = true;
}

/**
 * Write or update the status for a component.
 */
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
  await ensureTable();

  const vb = opts?.versionBefore ? `'${opts.versionBefore}'` : 'NULL';
  const va = opts?.versionAfter ? `'${opts.versionAfter}'` : 'NULL';
  const err = opts?.error ? `'${opts.error.replace(/'/g, "''")}'` : 'NULL';
  const sa = opts?.startedAt ? `'${opts.startedAt}'` : 'NOW()';

  await psqlExec(`
    INSERT INTO update_status (component, status, progress, message, version_before, version_after, error, started_at, updated_at)
    VALUES ('${component}', '${status}', ${progress}, '${message.replace(/'/g, "''")}', ${vb}, ${va}, ${err}, ${sa}, NOW())
    ON CONFLICT (component) DO UPDATE SET
      status = EXCLUDED.status,
      progress = EXCLUDED.progress,
      message = EXCLUDED.message,
      version_before = COALESCE(EXCLUDED.version_before, update_status.version_before),
      version_after = EXCLUDED.version_after,
      error = EXCLUDED.error,
      started_at = COALESCE(EXCLUDED.started_at, update_status.started_at),
      updated_at = NOW()
  `);
}

/**
 * Read the status for a single component from the DB.
 */
export async function readStatus(component: string): Promise<UpdateStatusRecord | null> {
  validateComponent(component);
  await ensureTable();

  const stdout = await psqlExec(
    `SELECT component, status, progress, message, version_before, version_after, error, started_at::text, updated_at::text FROM update_status WHERE component = '${component}'`
  );

  const lines = stdout.trim().split('\n').filter(l => l.length > 0);
  // First line is header, second is data
  if (lines.length < 2) return null;

  const fields = parseCSVLine(lines[1]);
  return {
    component: fields[0],
    status: fields[1],
    progress: parseInt(fields[2] || '0', 10),
    message: fields[3] || '',
    version_before: fields[4] || null,
    version_after: fields[5] || null,
    error: fields[6] || null,
    started_at: fields[7] || null,
    updated_at: fields[8] || '',
  };
}

/**
 * Read all active/recent update statuses from the DB.
 */
export async function readAllStatuses(): Promise<UpdateStatusRecord[]> {
  await ensureTable();

  const stdout = await psqlExec(
    `SELECT component, status, progress, message, version_before, version_after, error, started_at::text, updated_at::text FROM update_status ORDER BY updated_at DESC`
  );

  const lines = stdout.trim().split('\n').filter(l => l.length > 0);
  if (lines.length < 2) return [];

  // Skip header line
  return lines.slice(1).map(line => {
    const fields = parseCSVLine(line);
    return {
      component: fields[0],
      status: fields[1],
      progress: parseInt(fields[2] || '0', 10),
      message: fields[3] || '',
      version_before: fields[4] || null,
      version_after: fields[5] || null,
      error: fields[6] || null,
      started_at: fields[7] || null,
      updated_at: fields[8] || '',
    };
  });
}

/**
 * Clear the status for a component (delete the row).
 */
export async function clearStatus(component: string): Promise<void> {
  validateComponent(component);
  await ensureTable();
  await psqlExec(`DELETE FROM update_status WHERE component = '${component}'`);
}

/**
 * Get a unified view of all update statuses — aggregating
 * Spine's status file (via API) with CP-managed statuses (from DB).
 */
export async function getUnifiedStatuses(): Promise<UpdateStatusRecord[]> {
  const [dbStatuses, spineStatus] = await Promise.all([
    readAllStatuses().catch(() => [] as UpdateStatusRecord[]),
    spineClient.getUpdateStatus().catch(() => null),
  ]);

  const result = new Map<string, UpdateStatusRecord>();

  // Add DB statuses first
  for (const s of dbStatuses) {
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

/**
 * Convenience: start an update for a component.
 */
export async function startUpdate(component: string, versionBefore: string): Promise<void> {
  await writeStatus(component, 'checking', 0, 'Checking for updates...', {
    versionBefore,
  });
}

/**
 * Convenience: mark an update as completed.
 */
export async function completeUpdate(component: string, versionBefore: string, versionAfter: string): Promise<void> {
  await writeStatus(component, 'completed', 100, 'Update completed successfully', {
    versionBefore,
    versionAfter,
  });
}

/**
 * Convenience: mark an update as failed.
 */
export async function failUpdate(component: string, versionBefore: string, errorMsg: string): Promise<void> {
  await writeStatus(component, 'failed', 0, 'Update failed', {
    versionBefore,
    error: errorMsg,
  });
}

/**
 * Parse a single CSV line, handling quoted fields.
 */
function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        fields.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
  }
  fields.push(current);
  return fields;
}
