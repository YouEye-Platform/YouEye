import { randomUUID } from 'node:crypto';
import { execCommand, incusUploadFile } from '@/lib/incus/server';

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

export async function replacePlatformAppDatabase(options: {
  database: string;
  user: string;
  password: string;
  dump: Buffer;
}): Promise<void> {
  const database = checkedIdentifier(options.database, 'App database name');
  const user = checkedIdentifier(options.user, 'App database user');
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
  const roleSql = `CREATE ROLE ${userIdentifier} LOGIN PASSWORD '${sqlLiteral(options.password)}';\n`;
  await incusUploadFile(PLATFORM_POSTGRES_CONTAINER, rolePath, Buffer.from(roleSql, 'utf8'), {
    timeout: 10_000,
    mode: '0600',
  });
  try {
    await checkedExec(PLATFORM_POSTGRES_CONTAINER, [
      ...maintenance, '--file', rolePath,
    ], 10_000, `Create PostgreSQL role ${user}`);
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
  dump: Buffer;
}): Promise<void> {
  const database = checkedIdentifier(options.database, 'App database name');
  const user = checkedIdentifier(options.user, 'App database user');
  const databaseIdentifier = quotedIdentifier(database, 'App database name');
  const userIdentifier = quotedIdentifier(user, 'App database user');
  const databaseLiteral = sqlLiteral(database);
  const maintenance = ['psql', '--username', user, '--dbname', 'postgres', '--set', 'ON_ERROR_STOP=1'];

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
