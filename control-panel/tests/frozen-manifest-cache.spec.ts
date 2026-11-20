// The frozen-manifest cache must never answer with a copy of another version under the same record digest.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const root = process.env.CONTROL_PANEL_ROOT || path.join(import.meta.dirname, '..');

class AppUpdatePreflightError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

function loadModule(file: string, mocks: Record<string, unknown>) {
  const exports: Record<string, any> = {};
  const module = { exports };
  vm.runInNewContext(ts.transpileModule(readFileSync(path.join(root, 'src', file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText, { exports, module, console, structuredClone, require(name: string) {
    if (name in mocks) return mocks[name];
    return require(name);
  } });
  return module.exports;
}

test('a native app whose release changed under the same listing digest is read again, not refused', async () => {
  // The record's digest is the Market listing's: the same for 0.6.4 and 0.6.4-dev.2 of a native app.
  const record = { appId: 'notes', manifestDigest: 'sha256:listing', installedVersion: '0.6.4' };
  let row = '0.6.4';
  let reads = 0;
  const frozen = loadModule('lib/market/frozen-manifest.ts', {
    '@/lib/incus/server': { execCommand: async () => {
      reads++;
      return { exitCode: 0, stdout: JSON.stringify({ frozen: { schema: 'youeye.frozen-app.v1', manifest: 'm', setups: {}, version: row } }) };
    } },
    './app-format/compile': { loadFrozenApp: ({ version }: { version: string }) =>
      ({ metadata: { id: 'notes' }, version, frozen: { digest: 'sha256:listing' } }) },
    './update-inventory': { AppUpdatePreflightError },
    './metadata': { readInstallMetadata: async () => record },
  });

  assert.equal((await frozen.readFrozenUpdateManifest('notes', '0.6.4')).version, '0.6.4');
  assert.equal((await frozen.readFrozenUpdateManifest('notes', '0.6.4')).version, '0.6.4');
  assert.equal(reads, 1, 'the second read of the same version comes from the cache');

  // The update publishes the new release: same digest, new version.
  row = '0.6.4-dev.2';
  record.installedVersion = '0.6.4-dev.2';
  assert.equal((await frozen.readFrozenUpdateManifest('notes', '0.6.4-dev.2')).version, '0.6.4-dev.2');
  assert.equal(reads, 2, 'a cached copy of another version is read again');
});

test('a read without a version checks the cached copy against the install record', async () => {
  // Wiki and Search have no database: nothing reads them with a version during their update, and later readers
  // (the next update, a manifest sync) read without one.
  const record = { appId: 'wiki', manifestDigest: 'sha256:listing', installedVersion: '0.6.4' };
  let row = '0.6.4';
  let reads = 0;
  const frozen = loadModule('lib/market/frozen-manifest.ts', {
    '@/lib/incus/server': { execCommand: async () => {
      reads++;
      return { exitCode: 0, stdout: JSON.stringify({ frozen: { schema: 'youeye.frozen-app.v1', manifest: 'm', setups: {}, version: row } }) };
    } },
    './app-format/compile': { loadFrozenApp: ({ version }: { version: string }) =>
      ({ metadata: { id: 'wiki' }, version, frozen: { digest: 'sha256:listing' } }) },
    './update-inventory': { AppUpdatePreflightError },
    './metadata': { readInstallMetadata: async () => record },
  });
  assert.equal((await frozen.readFrozenUpdateManifest('wiki')).version, '0.6.4');
  assert.equal((await frozen.readFrozenUpdateManifest('wiki')).version, '0.6.4');
  assert.equal(reads, 1);

  // Forward: the release changed under the same digest.
  row = '0.6.4-dev.2';
  record.installedVersion = '0.6.4-dev.2';
  assert.equal((await frozen.readFrozenUpdateManifest('wiki')).version, '0.6.4-dev.2');
  assert.equal(reads, 2);

  // Back: a rollback restores the old registration and record.
  row = '0.6.4';
  record.installedVersion = '0.6.4';
  assert.equal((await frozen.readFrozenUpdateManifest('wiki')).version, '0.6.4');
  assert.equal(reads, 3);
});
