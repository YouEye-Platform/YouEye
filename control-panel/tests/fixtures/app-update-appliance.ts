/**
 * Explicit disposable-appliance fixture setup. Not a catalog application.
 * Bundle and run with the Control Panel service environment on an authorized
 * test appliance. Source URL and domain are caller-supplied; no credentials are
 * emitted. The regular install engine owns all created resources.
 */
import { AppManifestSchema } from '../../src/lib/market/schema';
import { installApp } from '../../src/lib/market/engine';
import { saveDirectMarketApp } from '../../src/lib/market/direct-apps';
import { readInstallMetadata } from '../../src/lib/market/metadata';
import { incusUploadFile, execCommand } from '../../src/lib/incus/server';
import { readFile } from 'node:fs/promises';
import { readSecret } from '../../src/lib/infrastructure/secrets';

export function fixtureManifest(mode: 'shared' | 'own', version = '1.0.0') {
  // Existing appliance NIC names use an app-ID prefix. Keep fixture prefixes
  // distinct so this transaction fixture does not depend on that naming limit.
  const appId = mode === 'own' ? 'migration-own-fixture' : 'migration-fixture-shared';
  const database = `migration_fixture_${mode}`;
  const role = `${database}_owner`;
  const clientEnvironment = mode === 'shared'
    ? { PGHOST: '${database.host}', PGPORT: '${database.port}', PGDATABASE: '${database.name}',
      PGUSER: '${database.user}', PGPASSWORD: '${database.password}' }
    : { PGHOST: '${containers.db.internal_host}', PGPORT: '5432', PGDATABASE: database,
      PGUSER: role, PGPASSWORD: '${secrets.db_password}' };
  return AppManifestSchema.parse({
    apiVersion: 'v1', kind: 'app', version,
    metadata: { id: appId, name: `Migration fixture (${mode})`,
      description: 'Disposable transaction acceptance fixture', icon: 'test-tube',
      category: 'developer', defaultSubdomain: appId },
    forwardAuth: 'enabled',
    database: mode === 'shared' ? { mode, name: database, user: role } : { mode, container: 'db' },
    backup: mode === 'own' ? { ownPostgres: { container: `app-${appId}-db`, database, user: role } } : undefined,
    secrets: [{ name: 'db_password', file: 'db-password', generator: 'password', length: 32 }],
    containers: [
      { name: 'main', type: 'oci', primary: true, image: 'docker.io/library/busybox:1.36.1', port: 8080,
        command: "sh -c 'mkdir -p /data/www; test -f /data/www/marker || echo old >/data/www/marker; exec httpd -f -p 8080 -h /data/www'",
        environment: clientEnvironment,
        volumes: [{ name: 'data', container: '/data', type: 'data' }],
        healthCheck: { type: 'http', path: '/marker', timeout: 30_000 },
      },
      { name: 'worker', type: 'oci', image: 'docker.io/library/postgres:17.10-alpine',
        command: "sh -c 'exec sleep 86400'", environment: clientEnvironment,
      },
      ...(mode === 'own' ? [{ name: 'db', type: 'oci', image: 'docker.io/library/postgres:17.10-alpine',
        environment: { POSTGRES_USER: 'postgres', POSTGRES_PASSWORD: '${secrets.db_password}', POSTGRES_DB: 'postgres' },
        volumes: [{ name: 'pgdata', container: '/var/lib/postgresql/data', type: 'data' }],
        healthCheck: { type: 'postgres', user: 'postgres', timeout: 60_000 },
      }] : []),
    ],
    configFiles: [{ container: 'main', path: '/data/www/config', template: 'old-config\n' }],
  });
}

/** Real provider inputs for normal updates and failures after durable mutation. */
export function fixtureTargetManifest(
  mode: 'shared' | 'own', version = '1.0.1', fromVersion = '1.0.0',
  failure?: 'pre-hook' | 'sql' | 'post-hook' | 'health',
) {
  const manifest = fixtureManifest(mode, version);
  manifest.containers[0].image = 'docker.io/library/busybox:1.37.0';
  manifest.containers[0].command =
    "sh -c 'echo new >/data/www/startup; exec httpd -f -p 8080 -h /data/www'";
  if (failure === 'health') manifest.containers[0].healthCheck = { type: 'http', path: '/missing', timeout: 5_000 };
  manifest.configFiles[0].template = 'new-config\n';
  manifest.update = {
    strategy: 'migrate', preserveData: true, preserveSecrets: true, version_constraint: 'any',
    pre_update: [{ exec_in: 'main', run: `echo hook-new >/data/www/marker${failure === 'pre-hook' ? '; exit 1' : ''}`, timeout: 30_000 }],
    migrations: [{
      fromVersion, toVersion: version, required: true,
      steps: [
        { type: 'sql', database: `migration_fixture_${mode}`,
          command: "ALTER TABLE fixture_rows ADD COLUMN revision integer DEFAULT 2; UPDATE fixture_rows SET value='new';" },
        ...(failure === 'sql' ? [{ type: 'exec' as const, container: 'main', command: 'exit 1', timeout: 30_000 }] : []),
      ],
    }],
    post_update: [{ exec_in: 'main', run: `echo new >/data/www/marker${failure === 'post-hook' ? '; exit 1' : ''}`, timeout: 30_000 }],
  };
  return AppManifestSchema.parse(manifest);
}

export async function installFixture(mode: 'shared' | 'own', domain: string, sourceURL: string) {
  const manifest = fixtureManifest(mode);
  if (await readInstallMetadata(manifest.metadata.id)) throw new Error('Fixture already exists; inspect before reuse');
  const entry = await saveDirectMarketApp({
    manifestUrl: sourceURL, manifestText: JSON.stringify(manifest), manifest,
  });
  await installApp(manifest, {
    appId: manifest.metadata.id, subdomain: manifest.metadata.defaultSubdomain, domain,
    sourceId: entry.sourceId, sourceName: 'Disposable fixture', sourceRepoUrl: sourceURL,
    manifestDigest: entry.manifestDigest, manifestPath: sourceURL, acceptUnverifiedPublisher: true,
    enableSSO: false, allowInternet: false,
  }, event => console.log(JSON.stringify({ stage: event.step, status: event.status })));
  const engine = mode === 'shared' ? 'youeye-postgres' : `app-${manifest.metadata.id}-db`;
  const admin = mode === 'shared' ? 'youeye' : 'postgres';
  const adminEnvironment = { PGOPTIONS: '-c log_statement=none -c log_min_error_statement=panic -c log_min_duration_statement=-1 -c log_min_duration_sample=-1 -c log_duration=off -c log_statement_stats=off' };
  const database = `migration_fixture_${mode}`;
  const role = `${database}_owner`;
  if (mode === 'own') {
    const password = await readSecret(`app-${manifest.metadata.id}`, 'db-password');
    if (!password || !/^[A-Za-z0-9_-]+$/.test(password)) throw new Error('Fixture credential unavailable');
    const remote = '/tmp/youeye-fixture-init.sql';
    await incusUploadFile(engine, remote, Buffer.from(
      `CREATE ROLE ${role} LOGIN PASSWORD '${password}';\nCREATE DATABASE ${database} OWNER ${role};\n`,
    ), { mode: '0600' });
    try {
      const result = await execCommand(engine, ['psql', '--no-psqlrc', '--no-password', '-U', admin,
        '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-f', remote], { timeout: 30_000, environment: adminEnvironment });
      if (result.exitCode !== 0) throw new Error('Fixture own database initialization failed');
    } finally {
      await execCommand(engine, ['rm', '-f', remote], { timeout: 10_000 });
    }
  }
  // Only this fixture role's sessions suppress SQL/error logging. No global
  // policy, existing role, account or password is changed.
  const setup = [
    `ALTER ROLE ${role} SET log_statement='none';`,
    `ALTER ROLE ${role} SET log_min_error_statement='panic';`,
    `ALTER ROLE ${role} SET log_min_messages='panic';`,
    `ALTER ROLE ${role} SET log_min_duration_statement='-1';`,
    `ALTER ROLE ${role} SET log_min_duration_sample='-1';`,
    `ALTER ROLE ${role} SET log_duration='off';`,
    `ALTER ROLE ${role} SET log_statement_stats='off';`,
    `SET ROLE ${role}; CREATE TABLE fixture_rows(id integer PRIMARY KEY, value text NOT NULL);`,
    `INSERT INTO fixture_rows VALUES(1,'old'); RESET ROLE;`,
  ].join('\n');
  const remote = '/tmp/youeye-fixture-setup.sql';
  await incusUploadFile(engine, remote, Buffer.from(setup), { mode: '0600' });
  try {
    const result = await execCommand(engine, ['psql', '--no-psqlrc', '--no-password', '-U', admin,
      '-d', database, '-v', 'ON_ERROR_STOP=1', '-f', remote], { timeout: 30_000, environment: adminEnvironment });
    if (result.exitCode !== 0) throw new Error('Fixture database setup failed');
  } finally {
    if ((await execCommand(engine, ['rm', '-f', remote], { timeout: 10_000 })).exitCode !== 0) {
      throw new Error('Fixture setup scratch cleanup failed');
    }
  }
  console.log(JSON.stringify({ appId: manifest.metadata.id, installed: true }));
}

// Optional JSON config file keeps caller-specific target/source data out of argv
// and the public fixture. This entry point performs setup only.
if (process.argv[2] === 'install') {
  (async () => {
    const config = JSON.parse(await readFile(process.argv[3], 'utf8'));
    if (!['shared', 'own'].includes(config.mode) || typeof config.domain !== 'string' || typeof config.sourceURL !== 'string') {
      throw new Error('Invalid fixture setup');
    }
    await installFixture(config.mode, config.domain, config.sourceURL);
  })().catch(() => { console.error('Disposable fixture setup failed; inspect scoped install status'); process.exitCode = 1; });
}
