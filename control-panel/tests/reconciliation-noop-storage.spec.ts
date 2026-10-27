import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { sameConnectionProjection } from '../src/lib/bridges/connection-projection';

function load(file: string, mocks: Record<string, unknown>, globals: Record<string, unknown> = {}) {
  const exports: Record<string, any> = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, {
    exports, console, process: { env: {} }, ...globals, require: (name: string) => mocks[name] ?? {},
  });
  return exports;
}

test('health storage persists actual transitions and debounce removal, but not unchanged resolutions', async () => {
  let stored: any = { issues: {}, debounce: {} }; let writes = 0;
  const api = load('src/lib/health/issues.ts', {
    '@/lib/health/issue-store': {
      readHealthRegistry: async () => structuredClone(stored),
      writeHealthRegistry: async (data: unknown) => { writes++; stored = structuredClone(data); },
    },
  });
  await api.resolveIssue('missing'); assert.equal(writes, 0);
  await api.observeIssue({ id: 'fixture', severity: 'error', source: 'test', title: 'Drift', body: 'Observed', debounce: 1 });
  assert.equal(writes, 1);
  await api.resolveIssue('fixture'); assert.equal(writes, 2); assert.equal(stored.issues.fixture.state, 'resolved');
  await api.resolveIssue('fixture'); assert.equal(writes, 2);
  stored.debounce.waiting = { count: 1, lastSeen: '2026-01-01' };
  await api.resolveIssue('waiting'); assert.equal(writes, 3); assert.equal(stored.debounce.waiting, undefined);
});

test('real connection projection skips unchanged posts and repairs observed drift', async () => {
  const requests: any[] = [];
  const api = load('src/lib/bridges/manager.ts', {
    './store': { getBridgesForApp: async () => [] },
    './internet-store': { listInternetGrants: async () => [] },
    '../market/catalog': { fetchManifest: async () => ({}) },
    '../market/metadata': { listInstalledApps: async () => [] },
    '../incus/container-ip': { getContainerIP: async () => '192.0.2.10' },
    'fs/promises': { readFile: async () => 'fixture-token' },
    './connection-projection': { sameConnectionProjection },
  }, {
    fetch: async (_url: string, request: any) => {
      assert.equal(request.headers['X-UI-Bridge-Token'], 'fixture-token');
      requests.push(JSON.parse(request.body)); return { ok: true };
    },
  });
  await api.pushConnectionsToUI('example', { required: true }); assert.equal(requests.length, 1);
  const { appId: _id, ...projection } = requests[0];
  await api.pushConnectionsToUI('example', { required: true, observed: { updatedAt: 'old', ...projection } });
  assert.equal(requests.length, 1);
  await assert.rejects(api.pushConnectionsToUI('example', { auditOnly: true, observed: { ...projection, internet: { granted: true } } }));
  assert.equal(requests.length, 1, 'a drifted read-only projection cannot POST before admission');
  await api.pushConnectionsToUI('example', { required: true, observed: { ...projection, internet: { granted: true } } });
  assert.equal(requests.length, 2);
  // A missing next-pass row never inherits a previous process-local success.
  await api.pushConnectionsToUI('example', { required: true, observed: null }); assert.equal(requests.length, 3);
});

test('projection comparison preserves transport authority and ignores only timestamp and key ordering', () => {
  const desired = { bridges: [{ transport: { address: '192.0.2.1', hostname: 'example.test', ca: 'public-ca-a' } }], available: [], internet: { granted: false, proxy: undefined } };
  assert.equal(sameConnectionProjection(JSON.parse(JSON.stringify({ updatedAt: 'old', ...desired })), desired), true);
  const changed = structuredClone(desired); changed.bridges[0].transport.ca = 'public-ca-b';
  assert.equal(sameConnectionProjection(changed, desired), false);
  assert.equal(sameConnectionProjection({ ...desired, unexpected: true }, desired), false);
});
