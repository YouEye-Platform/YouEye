/**
 * PostgreSQL Client
 *
 * Queries the youeye-postgres container via `incus exec` + psql.
 * This avoids needing the `pg` npm package (which has Turbopack bundling issues).
 */

import { execShell } from '@/lib/incus/server';
import { POSTGRES_MANIFEST } from '@/lib/apps/manifest';

const CONTAINER = POSTGRES_MANIFEST.containerName;

/**
 * Run a psql query inside the postgres container and return parsed CSV rows.
 * Uses psql's --csv output mode for reliable parsing.
 */
async function psqlQuery(sql: string): Promise<{ columns: string[]; rows: string[][] }> {
  // Escape single quotes in SQL for shell
  const escaped = sql.replace(/'/g, "'\\''");
  const { exitCode, stdout, stderr } = await execShell(
    CONTAINER,
    `su - postgres -c "psql -U youeye -d youeye --csv -c '${escaped}'"`,
    { timeout: 15000 }
  );

  if (exitCode !== 0) {
    throw new Error(`psql error: ${stderr}`);
  }

  // Filter out psql command tags that appear as raw lines in --csv mode
  // (e.g., BEGIN, COMMIT, SET from transaction wrapping)
  const COMMAND_TAGS = new Set(['BEGIN', 'COMMIT', 'ROLLBACK', 'SET', 'END']);
  const lines = stdout.trim().split('\n').filter(l => l.length > 0 && !COMMAND_TAGS.has(l.trim()));
  if (lines.length === 0) {
    return { columns: [], rows: [] };
  }

  const columns = parseCSVLine(lines[0]);
  const rows = lines.slice(1).map(parseCSVLine);
  return { columns, rows };
}

/**
 * Parse a single CSV line, handling quoted fields
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

/**
 * Execute a read-only SQL query (for the SQL console).
 * Returns columns and rows for display.
 */
export async function queryReadOnly(sql: string): Promise<{ columns: string[]; rows: string[][] }> {
  // Wrap in a read-only transaction
  const wrapped = `BEGIN TRANSACTION READ ONLY; ${sql}; COMMIT;`;
  return psqlQuery(wrapped);
}

/**
 * List all databases
 */
export async function listDatabases(): Promise<
  Array<{
    name: string;
    owner: string;
    encoding: string;
    size: string;
    tablespace: string;
  }>
> {
  const { rows } = await psqlQuery(`
    SELECT
      d.datname,
      r.rolname AS owner,
      pg_encoding_to_char(d.encoding) AS encoding,
      pg_size_pretty(pg_database_size(d.datname)) AS size,
      t.spcname AS tablespace
    FROM pg_database d
    LEFT JOIN pg_roles r ON d.datdba = r.oid
    LEFT JOIN pg_tablespace t ON d.dattablespace = t.oid
    WHERE d.datistemplate = false
    ORDER BY d.datname
  `);

  return rows.map(([name, owner, encoding, size, tablespace]) => ({
    name,
    owner,
    encoding,
    size,
    tablespace,
  }));
}

/**
 * Get database stats
 */
export async function getStats(): Promise<{
  version: string;
  uptime: string;
  activeConnections: number;
  maxConnections: number;
  databaseCount: number;
  totalSize: string;
  databases: Array<{ name: string; size: string; connections: number }>;
}> {
  // Run all queries in a single psql call for efficiency
  const { rows: versionRows } = await psqlQuery('SELECT version()');
  const { rows: uptimeRows } = await psqlQuery(
    "SELECT date_trunc('second', current_timestamp - pg_postmaster_start_time())::text AS uptime"
  );
  const { rows: connRows } = await psqlQuery(
    'SELECT count(*)::text FROM pg_stat_activity WHERE state IS NOT NULL'
  );
  const { rows: maxConnRows } = await psqlQuery('SHOW max_connections');
  const { rows: dbRows } = await psqlQuery(`
    SELECT
      d.datname,
      pg_size_pretty(pg_database_size(d.datname)) AS size,
      (SELECT count(*) FROM pg_stat_activity WHERE datname = d.datname)::text AS connections
    FROM pg_database d
    WHERE d.datistemplate = false
    ORDER BY pg_database_size(d.datname) DESC
  `);
  const { rows: totalRows } = await psqlQuery(
    "SELECT pg_size_pretty(sum(pg_database_size(datname))) AS total FROM pg_database WHERE datistemplate = false"
  );

  return {
    version: versionRows[0]?.[0] || 'unknown',
    uptime: uptimeRows[0]?.[0] || 'unknown',
    activeConnections: parseInt(connRows[0]?.[0] || '0', 10),
    maxConnections: parseInt(maxConnRows[0]?.[0] || '0', 10),
    databaseCount: dbRows.length,
    totalSize: totalRows[0]?.[0] || '0 bytes',
    databases: dbRows.map(([name, size, connections]) => ({
      name,
      size,
      connections: parseInt(connections, 10),
    })),
  };
}
