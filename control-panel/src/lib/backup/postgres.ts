import { randomUUID } from 'node:crypto';
import { execCommand, incusUploadFile, getInstanceState, updateInstanceState } from '@/lib/incus/server';
import { waitForOperation } from '@/lib/incus/snapshot';
import { beginContainerMaintenance } from '@/lib/maintenance/container-maintenance';
import { runOwnedPostgresBackup } from './owned-postgres-operation';
import { restoredAppOwnerSessionPolicy } from './postgres-owner-policy';

export const PLATFORM_POSTGRES_CONTAINER = 'youeye-postgres';
export const PLATFORM_POSTGRES_ADMIN = 'youeye';
export const PLATFORM_DATABASES = ['youeye', 'youeye_ui', 'pointer'] as const;

export function isPlatformDatabase(value: string): value is (typeof PLATFORM_DATABASES)[number] {
  return (PLATFORM_DATABASES as readonly string[]).includes(value);
}

export async function platformDatabaseExists(databaseInput: string): Promise<boolean> {
  const database = checkedIdentifier(databaseInput, 'Database name');
  const result = await checkedExec(PLATFORM_POSTGRES_CONTAINER, [
    'psql', '--username', PLATFORM_POSTGRES_ADMIN, '--dbname', 'postgres',
    '--tuples-only', '--no-align', '--command',
    `SELECT 1 FROM pg_database WHERE datname='${sqlLiteral(database)}'`,
  ], 10_000, `PostgreSQL database check for ${database}`);
  return result.stdout.trim() === '1';
}

const POSTGRES_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

function checkedIdentifier(value: string, label: string): string {
  if (!POSTGRES_IDENTIFIER.test(value)) {
    throw new Error(`${label} must be a safe PostgreSQL identifier`);
  }
  return value;
}

function quotedIdentifier(value: string, label: string): string {
  return `"${checkedIdentifier(value, label)}"`;
}

function sqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

// Logical app dumps omit role catalogs. Reconstruct the scoped owner's
// session privacy policy along with its credential, never arbitrary archived
// role settings, administrator privileges, or preload-library grants.
const PRIVATE_ROLE_SESSION = {
  PGOPTIONS: '-c log_statement=none -c log_min_error_statement=panic -c log_min_messages=panic -c log_min_duration_statement=-1 -c log_min_duration_sample=-1 -c log_duration=off -c log_statement_stats=off',
};

async function checkedExec(
  container: string,
  command: string[],
  timeout: number,
  operation: string,
) {
  const result = await execCommand(container, command, { timeout });
  if (result.exitCode !== 0) throw new Error(`${operation} failed`);
  return result;
}

export async function dumpPostgresDatabase(options: {
  container: string;
  database: string;
  user: string;
}): Promise<string> {
  const database = checkedIdentifier(options.database, 'Database name');
  const user = checkedIdentifier(options.user, 'Database user');
  const result = await checkedExec(options.container, [
    'pg_dump', '--username', user, '--dbname', database,
    '--no-owner', '--no-privileges',
  ], 120_000, `PostgreSQL dump for ${database}`);
  return result.stdout;
}

/** Caller holds the owning app lifecycle; never start a foreign/system database. */
export async function dumpAppOwnedPostgresDatabase(options: {
  container: string; database: string; user: string; ownedContainers: string[];
}): Promise<string> {
  if (!options.ownedContainers.includes(options.container)
    || options.container.startsWith('youeye-')) throw new Error('Application database is not an owned backup target');
  const database = checkedIdentifier(options.database, 'Database name');
  const user = checkedIdentifier(options.user, 'Database user');
  const change = async (action: 'start' | 'stop') => {
    const response = await updateInstanceState(options.container, action, false);
    if (response.type === 'error') throw new Error('Application database backup state transition failed');
    if (response.type === 'async' && response.operation) await waitForOperation(response.operation, 90);
  };
  return runOwnedPostgresBackup(() => dumpPostgresDatabase({ ...options, database, user }), {
    state: async () => {
      const response = await getInstanceState(options.container);
      const state = (response.metadata as { status?: unknown } | undefined)?.status;
      return response.type === 'error' || typeof state !== 'string' ? 'Unknown' : state;
    },
    start: () => change('start'), stop: () => change('stop'),
    ready: async () => {
      for (let attempt = 0; attempt < 30; attempt++) {
        try {
          const result = await execCommand(options.container,
            ['pg_isready', '--username', user, '--dbname', database], { timeout: 5_000 });
          if (result.exitCode === 0) return;
        } catch { /* A newly started OCI database may not accept exec yet. */ }
        await new Promise(resolve => setTimeout(resolve, 1_000));
      }
      throw new Error('Application database did not become ready for backup');
    },
    maintenance: () => beginContainerMaintenance([options.container], { operation: 'backup-own-postgres-originally-stopped' }),
  });
}

async function applyPostgresDump(options: {
  container: string;
  database: string;
  user: string;
  dump: Buffer;
}): Promise<void> {
  const database = checkedIdentifier(options.database, 'Database name');
  const user = checkedIdentifier(options.user, 'Database user');
  const remotePath = `/tmp/youeye-restore-${randomUUID()}.sql`;
  await incusUploadFile(options.container, remotePath, options.dump, {
    timeout: 300_000,
    mode: '0600',
  });
  try {
    await checkedExec(options.container, [
      'psql', '--username', user, '--dbname', database,
      '--set', 'ON_ERROR_STOP=1', '--file', remotePath,
    ], 300_000, `PostgreSQL restore for ${database}`);
  } finally {
    await execCommand(options.container, ['rm', '-f', remotePath], { timeout: 5_000 })
      .catch(() => undefined);
  }
}

export async function replacePlatformDatabase(databaseInput: string, dump: Buffer): Promise<void> {
  const database = checkedIdentifier(databaseInput, 'Database name');
  const databaseIdentifier = quotedIdentifier(database, 'Database name');
  const adminIdentifier = quotedIdentifier(PLATFORM_POSTGRES_ADMIN, 'Database owner');
  const databaseLiteral = sqlLiteral(database);
  const maintenance = ['psql', '--username', PLATFORM_POSTGRES_ADMIN, '--dbname', 'postgres', '--set', 'ON_ERROR_STOP=1'];

  await checkedExec(PLATFORM_POSTGRES_CONTAINER, [
    ...maintenance,
    '--command', `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${databaseLiteral}' AND pid <> pg_backend_pid()`,
  ], 10_000, `Terminate PostgreSQL clients for ${database}`);
  await checkedExec(PLATFORM_POSTGRES_CONTAINER, [
    ...maintenance, '--command', `DROP DATABASE IF EXISTS ${databaseIdentifier}`,
  ], 10_000, `Drop PostgreSQL database ${database}`);
  await checkedExec(PLATFORM_POSTGRES_CONTAINER, [
    ...maintenance, '--command', `CREATE DATABASE ${databaseIdentifier} OWNER ${adminIdentifier}`,
  ], 10_000, `Create PostgreSQL database ${database}`);
  await applyPostgresDump({
    container: PLATFORM_POSTGRES_CONTAINER,
    database,
    user: PLATFORM_POSTGRES_ADMIN,
    dump,
  });
}

/** UI must remain stopped until restored verifier rows are denied. */
export async function suspendRestoredAppCredentials(): Promise<void> {
  await checkedExec(PLATFORM_POSTGRES_CONTAINER, [
    'psql', '--username', PLATFORM_POSTGRES_ADMIN, '--dbname', 'youeye_ui',
    '--set', 'ON_ERROR_STOP=1', '--command',
    `DO $$ BEGIN
      IF to_regclass('public.app_service_credentials') IS NOT NULL THEN
        ALTER TABLE public.app_service_credentials ADD COLUMN IF NOT EXISTS ready BOOLEAN NOT NULL DEFAULT FALSE;
        UPDATE public.app_service_credentials SET ready = FALSE;
      END IF;
    END $$;`,
  ], 10_000, 'Suspend restored app credential readiness');
}

export async function replacePlatformAppDatabase(options: {
  database: string;
  user: string;
  password: string;
  dump: Buffer;
}): Promise<void> {
  const database = checkedIdentifier(options.database, 'App database name');
  const user = checkedIdentifier(options.user, 'App database user');
  const ownerSessionPolicy = restoredAppOwnerSessionPolicy(user);
  const databaseIdentifier = quotedIdentifier(database, 'App database name');
  const userIdentifier = quotedIdentifier(user, 'App database user');
  const databaseLiteral = sqlLiteral(database);
  const maintenance = ['psql', '--username', PLATFORM_POSTGRES_ADMIN, '--dbname', 'postgres', '--set', 'ON_ERROR_STOP=1'];

  await checkedExec(PLATFORM_POSTGRES_CONTAINER, [
    ...maintenance,
    '--command', `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${databaseLiteral}' AND pid <> pg_backend_pid()`,
  ], 10_000, `Terminate PostgreSQL clients for ${database}`);
  await checkedExec(PLATFORM_POSTGRES_CONTAINER, [
    ...maintenance, '--command', `DROP DATABASE IF EXISTS ${databaseIdentifier}`,
  ], 10_000, `Drop PostgreSQL database ${database}`);
  await checkedExec(PLATFORM_POSTGRES_CONTAINER, [
    ...maintenance, '--command', `DROP ROLE IF EXISTS ${userIdentifier}`,
  ], 10_000, `Drop PostgreSQL role ${user}`);

  const rolePath = `/tmp/youeye-role-${randomUUID()}.sql`;
  const roleSql = `CREATE ROLE ${userIdentifier} LOGIN PASSWORD '${sqlLiteral(options.password)}';\n`
    + ownerSessionPolicy;
  await incusUploadFile(PLATFORM_POSTGRES_CONTAINER, rolePath, Buffer.from(roleSql, 'utf8'), {
    timeout: 10_000,
    mode: '0600',
  });
  try {
    const result = await execCommand(PLATFORM_POSTGRES_CONTAINER, [
      ...maintenance, '--file', rolePath,
    ], { timeout: 10_000, environment: PRIVATE_ROLE_SESSION });
    if (result.exitCode !== 0) throw new Error('Restore application database owner failed');
  } finally {
    await execCommand(PLATFORM_POSTGRES_CONTAINER, ['rm', '-f', rolePath], { timeout: 5_000 })
      .catch(() => undefined);
  }

  await checkedExec(PLATFORM_POSTGRES_CONTAINER, [
    ...maintenance, '--command', `CREATE DATABASE ${databaseIdentifier} OWNER ${userIdentifier}`,
  ], 10_000, `Create PostgreSQL database ${database}`);
  await applyPostgresDump({
    container: PLATFORM_POSTGRES_CONTAINER,
    database,
    // The dump deliberately carries no owner or grant statements. Restore it
    // as the app role so tables, sequences, and routines remain visible and
    // writable to the app instead of becoming platform-admin-owned objects.
    user,
    dump: options.dump,
  });
}

export async function restoreOwnPostgresDatabase(options: {
  container: string;
  database: string;
  user: string;
  adminUser?: string;
  password?: string;
  dump: Buffer;
}): Promise<void> {
  const database = checkedIdentifier(options.database, 'App database name');
  const user = checkedIdentifier(options.user, 'App database user');
  const admin = checkedIdentifier(options.adminUser ?? user, 'App database administrator');
  const ownerSessionPolicy = admin !== user ? restoredAppOwnerSessionPolicy(user) : '';
  if (admin !== user && !options.password) throw new Error('Application database owner credential is unavailable');
  const databaseIdentifier = quotedIdentifier(database, 'App database name');
  const userIdentifier = quotedIdentifier(user, 'App database user');
  const databaseLiteral = sqlLiteral(database);
  const maintenance = ['psql', '--username', admin, '--dbname', 'postgres', '--set', 'ON_ERROR_STOP=1'];

  if (admin !== user) {
    const exists = await checkedExec(options.container, [...maintenance, '--tuples-only', '--no-align',
      '--command', `SELECT 1 FROM pg_roles WHERE rolname='${sqlLiteral(user)}'`], 10_000, 'Inspect application database owner');
    const rolePath = `/tmp/youeye-role-${randomUUID()}.sql`;
    // No grant/superuser/CREATEDB is restored. The administrator creates the
    // scoped database; logical objects are imported as their actual app owner.
    const statement = `${exists.stdout.trim() === '1' ? 'ALTER' : 'CREATE'} ROLE ${userIdentifier} LOGIN PASSWORD '${sqlLiteral(options.password!)}';\n`
      + ownerSessionPolicy;
    await incusUploadFile(options.container, rolePath, Buffer.from(statement), { timeout: 10_000, mode: '0600' });
    try {
      const result = await execCommand(options.container, [...maintenance, '--file', rolePath], {
        timeout: 10_000, environment: PRIVATE_ROLE_SESSION,
      });
      if (result.exitCode !== 0) throw new Error('Restore application database owner failed');
    } finally {
      const removed = await execCommand(options.container, ['rm', '-f', rolePath], { timeout: 5_000 });
      if (removed.exitCode !== 0) throw new Error('Restored application database owner credential cleanup failed');
    }
  }

  await checkedExec(options.container, [
    ...maintenance,
    '--command', `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${databaseLiteral}' AND pid <> pg_backend_pid()`,
  ], 10_000, `Terminate PostgreSQL clients for ${database}`);
  await checkedExec(options.container, [
    ...maintenance, '--command', `DROP DATABASE IF EXISTS ${databaseIdentifier}`,
  ], 10_000, `Drop PostgreSQL database ${database}`);
  await checkedExec(options.container, [
    ...maintenance, '--command', `CREATE DATABASE ${databaseIdentifier} OWNER ${userIdentifier}`,
  ], 10_000, `Create PostgreSQL database ${database}`);
  await applyPostgresDump({ ...options, database, user });
}
