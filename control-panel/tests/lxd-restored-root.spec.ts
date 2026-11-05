import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

function fixture(roots: Record<string, Record<string, string>>) {
  const effects: Array<{ method: string; route: string; body?: any }> = [];
  const mocks: Record<string, any> = {
    '../incus/server': {
      incusRequest: async (method: string, route: string, body?: any) => {
        if (method === 'GET') return { type: 'sync', metadata: {
          status: 'Stopped', architecture: 'x86_64', profiles: [], config: {},
          expanded_devices: { ...roots, staleNic: { type: 'nic', network: 'source-network' } },
        } };
        effects.push({ method, route, body }); return { type: 'sync' };
      },
      execShell: async () => ({ stdout: 'ready' }),
    },
    '../incus/static-ips': { applyStaticIP: async () => {} },
  };
  const exports: any = {};
  const source = readFileSync(path.join(process.env.CONTROL_PANEL_ROOT || process.cwd(),
    'src/lib/infrastructure/lxd-deployer.ts'), 'utf8');
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, { exports, require: (name: string) => mocks[name] ?? {} });
  const spec = { name: 'fixture', containerName: 'app-fixture', volumes: [
    { kind: 'custom', pool: 'data-pool', source: 'retained-data', container: '/data' },
  ] };
  return { effects, run: () => exports.adoptRestoredLXDContainer(spec,
    { eth0: { type: 'nic', network: 'target-network' } }) };
}

test('profile-free native adoption keeps its original root and replaces other devices before start', async () => {
  const root = { type: 'disk', path: '/', pool: 'retained-pool', size: '16GiB' };
  const f = fixture({ originalRoot: root }); await f.run();
  assert.equal(f.effects.length, 2);
  const update = f.effects[0];
  assert.equal(update.route, '/1.0/instances/app-fixture');
  assert.equal(JSON.stringify(update.body.devices.root), JSON.stringify(root));
  assert.equal(update.body.devices.eth0.network, 'target-network');
  assert.equal(update.body.devices.volume0.source, 'retained-data');
  assert.equal(update.body.devices.staleNic, undefined);
  assert.equal(JSON.stringify(update.body.profiles), '[]');
  assert.equal(f.effects[1].body.action, 'start');
});

test('native adoption rejects missing, ambiguous or unbound roots before any mutation', async () => {
  for (const roots of [{}, { root: { type: 'disk', path: '/' } }, {
    root: { type: 'disk', path: '/', pool: 'pool-a' },
    other: { type: 'disk', path: '/', pool: 'pool-b' },
  }]) {
    const f = fixture(roots); await assert.rejects(f.run(), /root pool is unresolved/);
    assert.equal(f.effects.length, 0);
  }
});
