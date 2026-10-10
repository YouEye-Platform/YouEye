import assert from 'node:assert/strict';
import test from 'node:test';
import { fixtureManifest } from './fixtures/app-update-appliance';
import { resolveOwnPostgresRestore } from '../src/lib/backup/own-postgres-restore';

test('fresh own PostgreSQL restore distinguishes administrator, app owner and restored client secret', () => {
  const manifest = fixtureManifest('own');
  assert.deepEqual(resolveOwnPostgresRestore(manifest, manifest.metadata.id), {
    container: 'app-migration-own-fixture-db', database: 'migration_fixture_own',
    user: 'migration_fixture_own_owner', adminUser: 'postgres', passwordFile: 'db-password',
  });
});

test('an app using its declared bootstrap administrator does not need a second role password', () => {
  const manifest = fixtureManifest('own');
  manifest.backup!.ownPostgres!.user = 'postgres';
  assert.equal(resolveOwnPostgresRestore(manifest, manifest.metadata.id).passwordFile, undefined);
});

test('administrator discovery follows the same global then container environment precedence as install', () => {
  const manifest = fixtureManifest('own');
  delete manifest.containers[2].environment.POSTGRES_USER;
  manifest.env_mapping = { POSTGRES_USER: 'migration_fixture_own_owner' };
  assert.equal(resolveOwnPostgresRestore(manifest, manifest.metadata.id).adminUser, 'migration_fixture_own_owner');
  assert.equal(resolveOwnPostgresRestore(manifest, manifest.metadata.id).passwordFile, undefined);
  manifest.containers[2].environment.POSTGRES_USER = 'postgres';
  assert.equal(resolveOwnPostgresRestore(manifest, manifest.metadata.id).adminUser, 'postgres');
});

test('refuse undeclared, foreign, shared and maintenance database identities before destructive restore', () => {
  const original = fixtureManifest('own');
  const wrong: Array<(manifest: typeof original) => void> = [
    manifest => { manifest.backup!.ownPostgres!.container = 'youeye-postgres'; },
    manifest => { manifest.backup!.ownPostgres!.container = 'app-foreign-db'; },
    manifest => { manifest.database!.container = 'worker'; },
    manifest => { manifest.backup!.ownPostgres!.database = 'postgres'; },
    manifest => { manifest.backup!.ownPostgres!.user = "owner'; DROP ROLE postgres; --"; },
    manifest => { manifest.containers[2].environment.POSTGRES_USER = '${unknown.admin}'; },
    manifest => { manifest.backup = undefined; },
  ];
  for (const change of wrong) { const manifest = structuredClone(original); change(manifest); assert.throws(() => resolveOwnPostgresRestore(manifest, manifest.metadata.id)); }
  assert.throws(() => resolveOwnPostgresRestore(fixtureManifest('shared'), original.metadata.id));
});

test('owner reconstruction requires one exact private manifest-declared password binding', () => {
  const original = fixtureManifest('own');
  for (const password of ['literal-password', '${unknown.password}', '${secrets.absent}']) {
    const manifest = structuredClone(original);
    for (const container of manifest.containers) if (container.environment.PGUSER) container.environment.PGPASSWORD = password;
    assert.throws(() => resolveOwnPostgresRestore(manifest, manifest.metadata.id), /one declared restored password/);
  }
  const outside = structuredClone(original); outside.secrets[0].file = '../outside';
  assert.throws(() => resolveOwnPostgresRestore(outside, outside.metadata.id));
  const ambiguous = structuredClone(original);
  ambiguous.secrets.push({ name: 'other', file: 'other-password', generator: 'password', length: 32 });
  ambiguous.containers[1].environment.PGPASSWORD = '${secrets.other}';
  assert.throws(() => resolveOwnPostgresRestore(ambiguous, ambiguous.metadata.id));
});
