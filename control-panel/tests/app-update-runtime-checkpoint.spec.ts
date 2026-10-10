import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import ts from 'typescript';

function fixture() {
  const id = '12345678-1234-4234-8234-123456789abc';
  const original = {
    name: 'app-fixture', profiles: ['fixture'],
    config: { 'image.id': 'old', 'volatile.base_image': 'old-image' },
    devices: { data: { type: 'disk', source: 'fixture-data', path: '/data' },
      eth0: { type: 'nic', hwaddr: '10:00:00:00:00:01' } },
    expanded_devices: { data: { type: 'disk', source: 'fixture-data', path: '/data' },
      eth0: { type: 'nic', hwaddr: '10:00:00:00:00:01' },
      ingress: { type: 'proxy', listen: 'tcp:0.0.0.0:8080' } },
  };
  const instances = new Map<string, any>([[original.name, structuredClone(original)]]);
  const effects: string[] = [];
  const record = { id, appId: 'fixture', phase: 'recovering', originalRunning: { 'app-fixture': true },
    steps: [{ id: 'initialize-recovery-plan', state: 'complete' }, { phase: 'applying' }],
    resources: [{ kind: 'container', scope: 'incus', name: original.name }],
    checkpoints: [{ method: 'runtime-copy', resource: original.name, reference: 'retained' }] };
  const metadata = { installedVersion: '1.0.0' };
  const output = ts.transpileModule(readFileSync(join(import.meta.dirname, '../src/lib/market/update-provider.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: any = {};
  new Function('require', 'exports', output)((name: string) => {
    if (name === '@/lib/incus/server') return { incusRequest: async (method: string, url: string, body?: any) => {
      const key = decodeURIComponent(url.split('/').at(-1)!);
      if (method === 'GET') return instances.has(key)
        ? { type: 'sync', metadata: structuredClone(instances.get(key)) } : { type: 'error', error_code: 404 };
      effects.push(`${method} ${url}`);
      if (method === 'POST' && url === '/1.0/instances') {
        const source = instances.get(body.source.source);
        const copy = { ...structuredClone(source), name: body.name, config: body.config, devices: body.devices };
        copy.expanded_devices = { ...source.expanded_devices, ...body.devices };
        instances.set(body.name, copy);
      } else if (method === 'PUT') {
        const current = instances.get(key);
        instances.set(key, { ...current, ...body,
          expanded_devices: { ingress: original.expanded_devices.ingress, ...body.devices } });
      } else if (method === 'POST') {
        instances.set(body.name, { ...instances.get(key), name: body.name });
        instances.delete(key);
      }
      return { type: 'sync' };
    } };
    if (name === '@/lib/incus/snapshot') return {
      containerState: async () => 'Stopped',
      deleteInstance: async (name: string) => { effects.push(`DELETE ${name}`); instances.delete(name); },
      buildRollbackCopyRequest: (source: string, name: string) => ({ name, source: { type: 'copy', source } }),
    };
    if (name === './update-journal') return { updateResourceKey: (r: any) => r.name };
    if (name === './metadata') return { readInstallMetadata: async () => metadata, saveInstallMetadata: async () => {} };
    if (name === './installed-apps') return { restoreInstalledAppUpdateState: async () => {} };
    if (name === './ui-manifest-sync') return { syncAppManifestObjectToUI: async () => {} };
    return {};
  }, exports);
  const provider = new exports.IncusAppUpdateProvider();
  provider.load = () => ({ instances: [original], metadata, installed: {}, manifest: {} });
  provider.ensureCurrentSecurity = provider.ingress = provider.bootFence = async () => {};
  provider.postgres = async () => undefined;
  return { id, original, instances, effects, provider, record };
}

test('stopped runtime checkpoints disable local and profile NIC/proxy identities while preserving disks', async () => {
  const f = fixture();
  await f.provider.copyRuntime(f.record, 'app-fixture', 'retained', 'app-fixture');
  const copy = f.instances.get('retained');
  assert.deepEqual(copy.devices.eth0, { type: 'none' });
  assert.deepEqual(copy.devices.ingress, { type: 'none' });
  assert.deepEqual(copy.devices.data, f.original.devices.data);
  assert.deepEqual(f.instances.get('app-fixture'), f.original);
});

test('recovery isolates an owned legacy copy and restores canonical devices and profiles', async () => {
  const f = fixture();
  f.instances.set('retained', { ...structuredClone(f.original), name: 'retained',
    config: { ...f.original.config, 'user.youeye.update_operation': f.id, 'user.youeye.update_source': 'app-fixture' } });
  await f.provider.restore(f.record);
  assert.deepEqual(f.instances.get('retained').devices.eth0, { type: 'none' });
  assert.deepEqual(f.instances.get('retained').devices.ingress, { type: 'none' });
  assert.deepEqual(f.instances.get('app-fixture').devices, f.original.devices);
  assert.deepEqual(f.instances.get('app-fixture').profiles, f.original.profiles);
});

test('recovery refuses foreign retained copies before detaching devices or deleting canonical runtime', async () => {
  const f = fixture();
  f.instances.set('retained', { ...structuredClone(f.original), name: 'retained',
    config: { ...f.original.config, 'user.youeye.update_operation': 'foreign' } });
  await assert.rejects(f.provider.restore(f.record), /identity mismatch/);
  assert.deepEqual(f.effects, []);
});
