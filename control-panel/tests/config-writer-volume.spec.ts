import assert from 'node:assert/strict';
import test from 'node:test';
import { configVolumeTarget } from '../src/lib/market/config-writer';
import type { ConfigFileSpec, StorageVolumeMeta } from '../src/lib/market/types';

const spec = (path: string): ConfigFileSpec => ({
  container: 'main',
  path,
  permission: '0o600',
  directoryPermission: '0o700',
  template: 'test',
});

const volume = (overrides: Partial<StorageVolumeMeta> = {}): StorageVolumeMeta => ({
  appId: 'test',
  name: 'ye-test-main-config',
  logicalName: 'config',
  pool: 'default',
  containerName: 'app-test',
  containerPath: '/etc/test',
  type: 'config',
  readOnly: false,
  backup: true,
  ...overrides,
});

test('generated config resolves to its backing custom volume path', () => {
  assert.deepEqual(
    configVolumeTarget(spec('/etc/test/settings.yml'), [volume()], {}),
    { pool: 'default', volume: 'ye-test-main-config', path: '/settings.yml', readOnly: false },
  );
});

test('the deepest mounted volume wins for nested mount paths', () => {
  assert.deepEqual(
    configVolumeTarget(spec('/etc/test/private/settings.yml'), [
      volume(),
      volume({ name: 'ye-test-main-private', logicalName: 'private', containerPath: '/etc/test/private' }),
    ], {}),
    { pool: 'default', volume: 'ye-test-main-private', path: '/settings.yml', readOnly: false },
  );
});

test('source-volume attachments retain their backing subpath', () => {
  assert.deepEqual(
    configVolumeTarget(spec('/etc/test/settings.yml'), [
      volume({
        containerPath: '/etc/test',
        sourcePath: 'generated/config',
        attachmentOnly: true,
      }),
    ], {}),
    { pool: 'default', volume: 'ye-test-main-config', path: '/generated/config/settings.yml', readOnly: false },
  );
});

test('the resolved target retains read-only attachment state', () => {
  assert.deepEqual(
    configVolumeTarget(spec('/etc/test/private/settings.yml'), [
      volume(),
      volume({ containerPath: '/etc/test/private', readOnly: true }),
    ], {}),
    { pool: 'default', volume: 'ye-test-main-config', path: '/settings.yml', readOnly: true },
  );
});

test('root-mounted durable storage resolves files without collapsing the mount', () => {
  assert.deepEqual(
    configVolumeTarget(spec('/settings.yml'), [volume({ containerPath: '/' })], {}),
    { pool: 'default', volume: 'ye-test-main-config', path: '/settings.yml', readOnly: false },
  );
});

test('generated config must target a file inside declared durable storage', () => {
  assert.throws(
    () => configVolumeTarget(spec('/tmp/settings.yml'), [volume()], {}),
    /does not resolve to durable app storage/,
  );
  assert.throws(
    () => configVolumeTarget(spec('/etc/test'), [volume()], {}),
    /must target a file inside durable app storage/,
  );
});
