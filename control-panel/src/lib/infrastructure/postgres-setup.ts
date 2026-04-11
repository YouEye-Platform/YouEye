/**
 * PostgreSQL database setup for Authentik.
 * Creates the 'authentik' database and user inside youeye-postgres.
 * Idempotent — safe to call on every deploy.
 */

import { execShell } from '../incus/server';
import { getOrCreateSecret, generatePassword, generateSecretKey, generateHexToken } from './secrets';

/**
 * Setup Authentik database and generate all required secrets.
 * Returns the secrets needed for Authentik deployment.
 */
export async function setupAuthentikDatabase(): Promise<{
  dbPassword: string;
  secretKey: string;
  bootstrapToken: string;
  bootstrapPassword: string;
}> {
  const dbPassword = await getOrCreateSecret('authentik', '.db_password', () => generatePassword(32));
  const secretKey = await getOrCreateSecret('authentik', '.secret_key', () => generateSecretKey(50));
  const bootstrapToken = await getOrCreateSecret('authentik', '.bootstrap_token', () => generateHexToken(20));
  const bootstrapPassword = await getOrCreateSecret('authentik', '.bootstrap_password', () => generatePassword(24));

  // Check if user exists
  const checkUser = await execShell(
    'youeye-postgres',
    "psql -U youeye -tAc \"SELECT 1 FROM pg_roles WHERE rolname='authentik'\"",
    { timeout: 10_000 }
  );

  if (!checkUser.stdout.includes('1')) {
    const sql = `CREATE USER authentik WITH PASSWORD '${dbPassword}'`;
    const result = await execShell('youeye-postgres', `psql -U youeye -c "${sql}"`, {
      timeout: 10_000,
    });
    if (result.exitCode !== 0) {
      throw new Error(`Failed to create authentik user: ${result.stderr}`);
    }
  }

  // Check if database exists
  const checkDB = await execShell(
    'youeye-postgres',
    "psql -U youeye -tAc \"SELECT 1 FROM pg_database WHERE datname='authentik'\"",
    { timeout: 10_000 }
  );

  if (!checkDB.stdout.includes('1')) {
    const result = await execShell(
      'youeye-postgres',
      'psql -U youeye -c "CREATE DATABASE authentik OWNER authentik"',
      { timeout: 10_000 }
    );
    if (result.exitCode !== 0) {
      throw new Error(`Failed to create authentik database: ${result.stderr}`);
    }
  }

  return { dbPassword, secretKey, bootstrapToken, bootstrapPassword };
}
