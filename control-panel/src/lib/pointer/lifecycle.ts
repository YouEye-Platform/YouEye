import { execCommand } from '@/lib/incus/server';
import { CONTAINER_DOMAIN } from '@/lib/market/constants';
import { generatePassword, getOrCreateSecret, readSecret } from '@/lib/infrastructure/secrets';
import { getIdentityConfig } from '@/lib/identity/config';
import { POINTER_PLATFORM_AUDIENCE, POINTER_PLATFORM_SUBJECT } from '@/lib/identity/tokens';
import { injectCaddyRootCA } from '@/lib/market/caddy-ca';

const POINTER_DATABASE = 'pointer';
const POINTER_CONTAINER = 'youeye-pointer';

async function ensurePointerDatabase(postgresPassword: string) {
  const check = await execCommand('youeye-postgres', [
    '/usr/local/bin/psql', '-U', 'youeye', '-d', 'postgres', '-tAc',
    `SELECT 1 FROM pg_database WHERE datname='${POINTER_DATABASE}'`,
  ], { environment: { PGPASSWORD: postgresPassword }, timeout: 15_000 });
  if (check.exitCode !== 0) throw new Error('Pointer database preflight failed');
  if (check.stdout.trim() !== '1') {
    const created = await execCommand('youeye-postgres', [
      '/usr/local/bin/createdb', '-U', 'youeye', POINTER_DATABASE,
    ], { environment: { PGPASSWORD: postgresPassword }, timeout: 30_000 });
    if (created.exitCode !== 0) throw new Error('Pointer database creation failed');
  }
}

export async function configurePointerService() {
  const postgresPassword = await readSecret('postgres', '.pg_password');
  if (!postgresPassword) throw new Error('PostgreSQL credential is unavailable');
  const [jwtSecret, encryptionSecret, identity] = await Promise.all([
    getOrCreateSecret('pointer', '.jwt_secret', () => generatePassword(64)),
    getOrCreateSecret('pointer', '.encryption_secret', () => generatePassword(64)),
    getIdentityConfig(),
  ]);
  await ensurePointerDatabase(postgresPassword);
  await injectCaddyRootCA(POINTER_CONTAINER);

  const databaseUrl = `postgresql://youeye:${encodeURIComponent(postgresPassword)}@youeye-postgres.${CONTAINER_DOMAIN}:5432/${POINTER_DATABASE}`;
  // This file is inside the signed release artifact. Forward its public
  // identity so readiness reports the deployed build instead of a dev default.
  const release = await execCommand(POINTER_CONTAINER, [
    '/bin/cat', '/opt/pointer/release-manifest.json',
  ], { timeout: 10_000 });
  const build = release.exitCode === 0 ? JSON.parse(release.stdout) as Record<string, unknown> : {};
  const buildFields: Record<string, unknown> = {
    POINTER_COMPONENT_VERSION: build.version,
    POINTER_BUILD_REPOSITORY: build.repository,
    POINTER_BUILD_BRANCH: build.branch,
    POINTER_BUILD_COMMIT: build.commit,
  };
  const buildEnvironment = Object.fromEntries(Object.entries(buildFields).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string' && /^[A-Za-z0-9:/._-]+$/.test(entry[1]),
  ));
  const environment = {
    ...buildEnvironment,
    POINTER_DATABASE_URL: databaseUrl,
    POINTER_JWT_SECRET: jwtSecret,
    POINTER_ENCRYPTION_SECRET: encryptionSecret,
    POINTER_PLATFORM_ISSUER: identity.issuer,
    POINTER_PLATFORM_JWKS: `${identity.externalUrl}/oauth/jwks`,
    POINTER_PLATFORM_AUDIENCE: POINTER_PLATFORM_AUDIENCE,
    POINTER_PLATFORM_SUBJECT: POINTER_PLATFORM_SUBJECT,
    POINTER_PROVIDERS_DIR: '/opt/pointer/providers.d',
    POINTER_MIGRATIONS_DIR: '/opt/pointer/drizzle',
  };
  const writeEnvironment = await execCommand(POINTER_CONTAINER, ['/bin/sh', '-c', [
    'umask 077',
    // The no-op keeps the grouped command valid after the array is joined
    // with semicolons (`{ :; ...; }`). A bare `{;` is invalid POSIX shell.
    '{ :',
    'printf "%s\\n" "DATABASE_URL=$POINTER_DATABASE_URL"',
    'printf "%s\\n" "JWT_SECRET=$POINTER_JWT_SECRET"',
    'printf "%s\\n" "ENCRYPTION_SECRET=$POINTER_ENCRYPTION_SECRET"',
    'printf "%s\\n" "POINTER_DEPLOYMENT_MODE=managed"',
    'printf "%s\\n" "POINTER_BACKGROUND_JOBS_ENABLED=true"',
    'printf "%s\\n" "MANAGEMENT_BIND=0.0.0.0"',
    'printf "%s\\n" "MANAGEMENT_PORT=4001"',
    'printf "%s\\n" "INFERENCE_BIND=0.0.0.0"',
    'printf "%s\\n" "INFERENCE_PORT=4002"',
    'printf "%s\\n" "PLATFORM_ISSUER=$POINTER_PLATFORM_ISSUER"',
    'printf "%s\\n" "PLATFORM_AUDIENCE=$POINTER_PLATFORM_AUDIENCE"',
    'printf "%s\\n" "PLATFORM_SUBJECT=$POINTER_PLATFORM_SUBJECT"',
    'printf "%s\\n" "PLATFORM_INTEGRATION_ID=youeye-native"',
    'printf "%s\\n" "PLATFORM_JWKS_URL=$POINTER_PLATFORM_JWKS"',
    'printf "%s\\n" "PLATFORM_SIGNING_ALGORITHMS=RS256"',
    'printf "%s\\n" \'MANAGED_SERVICE_PRINCIPAL_NAME="YouEye managed applications"\'',
    'printf "%s\\n" "POINTER_PROVIDERS_DIR=$POINTER_PROVIDERS_DIR"',
    'printf "%s\\n" "POINTER_MIGRATIONS_DIR=$POINTER_MIGRATIONS_DIR"',
    ...Object.keys(buildEnvironment).map((key) => `printf "%s\\n" "${key}=$${key}"`),
    '} > /etc/youeye-pointer.env',
  ].join('; ')], { environment, timeout: 15_000 });
  if (writeEnvironment.exitCode !== 0) throw new Error('Pointer service configuration failed');

  const migrated = await execCommand(POINTER_CONTAINER, [
    '/opt/pointer/bun', '/opt/pointer/migrate.js', '--expect-database', POINTER_DATABASE,
  ], { environment: { DATABASE_URL: databaseUrl, POINTER_MIGRATIONS_DIR: environment.POINTER_MIGRATIONS_DIR }, timeout: 120_000 });
  if (migrated.exitCode !== 0) throw new Error('Pointer database migration failed');

  const enabled = await execCommand(POINTER_CONTAINER, [
    '/usr/bin/systemctl', 'enable', 'youeye-pointer.service',
  ], { timeout: 30_000 });
  if (enabled.exitCode !== 0) throw new Error('Pointer service enable failed');

  // A configured service may already be healthy under the old platform
  // issuer. Always restart after writing the managed environment so setup and
  // later domain changes take effect immediately.
  const restarted = await execCommand(POINTER_CONTAINER, [
    '/usr/bin/systemctl', 'restart', 'youeye-pointer.service',
  ], { timeout: 30_000 });
  if (restarted.exitCode !== 0) throw new Error('Pointer service restart failed');
}

/**
 * Keep an already-created Pointer container quiet until onboarding supplies
 * the platform domain used by its managed identity issuer. The release's
 * standalone defaults deliberately fail closed without CORS_ORIGIN, so
 * allowing systemd to repeatedly start it before managed configuration exists
 * creates a permanent crash loop rather than useful bootstrap progress.
 */
export async function deferPointerServiceUntilSetup() {
  const stopped = await execCommand(POINTER_CONTAINER, [
    '/usr/bin/systemctl', 'disable', '--now', 'youeye-pointer.service',
  ], { timeout: 30_000 });
  if (stopped.exitCode !== 0) throw new Error('Pointer service could not be deferred until setup');
}

export async function waitForPointer(timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await execCommand(POINTER_CONTAINER, [
      '/usr/bin/curl', '--silent', '--show-error', '--fail', '--max-time', '5',
      'http://127.0.0.1:4001/readyz',
    ], { timeout: 7_000 }).catch(() => null);
    if (result?.exitCode === 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return false;
}
