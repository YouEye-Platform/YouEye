import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import path from 'node:path';
import type { ConfigFileSpec, StorageVolumeMeta } from '../src/lib/market/types';

function fixture() {
  const files = new Map<string, Buffer>();
  const writes: string[] = [];
  const source = readFileSync(join(import.meta.dirname, '../src/lib/market/config-writer.ts'), 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const exports: any = {};
  const volumeKey = (pool: string, volume: string, file: string) => `${pool}/${volume}${file}`;
  new Function('require', 'exports', output)((name: string) => {
    if (name === 'path') return path;
    if (name === '../incus/snapshot') return { waitForContainerExec: async () => {} };
    if (name === './variables') return { resolveVariables: (value: string) => value };
    if (name === '../incus/server') return {
      incusUploadFile: async (_container: string, file: string, content: Buffer) => {
        if (file.startsWith('/data/')) throw new Error('Stopped instance has no mounted /data');
        writes.push(`root:${file}`);
        files.set(file, content);
      },
      incusDownloadFile: async (_container: string, file: string) => files.get(file),
      incusInspectVolumeFile: async (pool: string, volume: string, file: string) =>
        files.has(volumeKey(pool, volume, file)) ? { type: 'file', mode: '0600' }
          : file === '/' ? { type: 'directory', mode: '0700' } : null,
      incusCreateVolumeDirectory: async () => {},
      incusUploadVolumeFile: async (pool: string, volume: string, file: string, content: Buffer) => {
        const key = volumeKey(pool, volume, file);
        writes.push(`volume:${key}`);
        files.set(key, content);
      },
      incusDownloadVolumeFile: async (pool: string, volume: string, file: string) =>
        files.get(volumeKey(pool, volume, file)),
    };
    throw new Error(`Unexpected import ${name}`);
  }, exports);
  return { write: exports.writeAllConfigFiles, writes, files };
}

const spec = (file: string): ConfigFileSpec => ({
  container: 'main', path: file, template: 'new-config',
  permission: '0o600', directoryPermission: '0o700',
});
const volume = (overrides: Partial<StorageVolumeMeta> = {}): StorageVolumeMeta => ({
  appId: 'fixture', containerName: 'app-fixture', name: 'fixture-data',
  logicalName: 'data', containerPath: '/data', pool: 'default',
  type: 'data', readOnly: false, backup: true, ...overrides,
});

test('stopped native updates write mounted config through its volume and root config through the instance', async () => {
  const f = fixture();
  await f.write([spec('/data/config'), spec('/etc/app-config')], 'main', 'app-fixture', {}, [volume()], true);
  assert.deepEqual(f.writes, ['volume:default/fixture-data/config', 'root:/etc/app-config']);
  assert.equal(f.files.get('default/fixture-data/config')?.toString(), 'new-config');
  assert.equal(f.files.get('/etc/app-config')?.toString(), 'new-config');
});

test('a native nested read-only attachment is refused instead of falling back to writable root transport', async () => {
  const f = fixture();
  await assert.rejects(f.write([spec('/data/private/config')], 'main', 'app-fixture', {}, [
    volume(), volume({ name: 'private-data', containerPath: '/data/private', readOnly: true }),
  ], true), /read-only/);
  assert.deepEqual(f.writes, []);
});

test('OCI updates still reject root config outside declared durable storage', async () => {
  const f = fixture();
  await assert.rejects(f.write([spec('/etc/app-config')], 'main', 'app-fixture', {}, [volume()]),
    /does not resolve to durable app storage/);
  assert.deepEqual(f.writes, []);
});

test('native source-volume aliases keep their backing subpath when the instance is stopped', async () => {
  const f = fixture();
  await f.write([spec('/data/config')], 'main', 'app-fixture', {},
    [volume({ attachmentOnly: true, sourcePath: 'app/config' })], true);
  assert.deepEqual(f.writes, ['volume:default/fixture-data/app/config/config']);
});
