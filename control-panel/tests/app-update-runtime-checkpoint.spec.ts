import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { containerOrder } from './fixtures/update-provider-harness';
import { generatedSecretNames } from '../src/lib/market/manifest-secrets';

function fixture() {
  const id = '12345678-1234-4234-8234-123456789abc';
  const original = {
    name: 'app-fixture', profiles: ['fixture'],
    config: { 'image.id': 'old', 'volatile.base_image': 'old-image', 'volatile.eth0.hwaddr': '10:66:6a:00:00:01' },
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
  const metadata: Record<string, any> = { installedVersion: '1.0.0',
    containers: [{ name: 'main', containerName: 'app-fixture', type: 'oci', primary: true }] };
  // What the install record holds now (the update may have written it); restore() saves into `saved`.
  const current: { value: Record<string, any> } = { value: metadata };
  const saved: Record<string, any>[] = [];
  const removedSecrets: string[] = [];
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
      stopContainer: async () => {}, stopTimeoutSec: () => 60,
      deleteInstance: async (name: string) => { effects.push(`DELETE ${name}`); instances.delete(name); },
      buildRollbackCopyRequest: (source: string, name: string) => ({ name, source: { type: 'copy', source } }),
    };
    if (name === '@/lib/apps/container-order') return containerOrder();
    if (name === './update-journal') return { updateResourceKey: (r: any) => r.name };
    if (name === './metadata') return { readInstallMetadata: async () => current.value,
      saveInstallMetadata: async (value: Record<string, any>) => { saved.push(structuredClone(value)); } };
    if (name === './manifest-secrets') return { removeGeneratedSecrets: async (r: any) => {
      const names = generatedSecretNames(r);
      removedSecrets.push(...names.map((n) => `${r.appId}/${n}`));
      return names;
    } };
    if (name === './installed-apps') return { restoreInstalledAppUpdateState: async () => {} };
    if (name === './ui-manifest-sync') return { syncAppManifestObjectToUI: async () => {} };
    return {};
  }, exports);
  const provider = new exports.IncusAppUpdateProvider();
  provider.load = () => ({ instances: [original], metadata, installed: {}, manifest: {} });
  provider.ingress = provider.bootFence = async () => {};
  provider.postgres = async () => undefined;
  return { id, original, instances, effects, provider, record, metadata, current, saved, removedSecrets };
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

test('recovery isolates an owned retained copy and restores canonical devices and profiles', async () => {
  const f = fixture();
  f.instances.set('retained', { ...structuredClone(f.original), name: 'retained',
    config: { ...f.original.config, 'user.youeye.update_operation': f.id, 'user.youeye.update_source': 'app-fixture' } });
  await f.provider.restore(f.record);
  assert.deepEqual(f.instances.get('retained').devices.eth0, { type: 'none' });
  assert.deepEqual(f.instances.get('retained').devices.ingress, { type: 'none' });
  assert.deepEqual(f.instances.get('app-fixture').devices, f.original.devices);
  assert.deepEqual(f.instances.get('app-fixture').profiles, f.original.profiles);
  // The restored container has the original MAC address.
  assert.equal(f.instances.get('app-fixture').config['volatile.eth0.hwaddr'], '10:66:6a:00:00:01');
});

test('recovery refuses foreign retained copies before detaching devices or deleting canonical runtime', async () => {
  const f = fixture();
  f.instances.set('retained', { ...structuredClone(f.original), name: 'retained',
    config: { ...f.original.config, 'user.youeye.update_operation': 'foreign' } });
  await assert.rejects(f.provider.restore(f.record), /identity mismatch/);
  assert.deepEqual(f.effects, []);
});

test('a rollback deletes only the secrets its update generated and restores the shown credentials (YE-208)', async () => {
  const f = fixture();
  f.instances.set('retained', { ...structuredClone(f.original), name: 'retained',
    config: { ...f.original.config, 'user.youeye.update_operation': f.id, 'user.youeye.update_source': 'app-fixture' } });
  // The update generated admin_password (completed) and started session_key (intent only: it may or may not exist).
  f.record.steps.push({ id: 'generate-secret-admin_password', phase: 'applying', state: 'completed' } as any,
    { id: 'generate-secret-session_key', phase: 'applying', state: 'intent' } as any,
    { id: 'apply-generated-configuration', phase: 'applying', state: 'intent' } as any);
  // It had also written the new release's credentials into the record before it failed.
  f.current.value = { ...f.metadata, installedVersion: '2.0.0',
    credentials: [{ label: 'Administrator', username: 'admin', passwordSecret: 'admin_password' }] };
  await f.provider.restore(f.record);
  assert.deepEqual(f.removedSecrets, ['fixture/admin_password', 'fixture/session_key']);
  const restored = f.saved.at(-1)!;
  assert.equal(restored.installedVersion, '1.0.0');
  assert.equal(Object.hasOwn(restored, 'credentials'), false, 'the release before had none: none are shown again');
});

test('a rollback of an app that had credentials shows the ones it had (YE-208)', async () => {
  const f = fixture();
  f.instances.set('retained', { ...structuredClone(f.original), name: 'retained',
    config: { ...f.original.config, 'user.youeye.update_operation': f.id, 'user.youeye.update_source': 'app-fixture' } });
  f.metadata.credentials = [{ label: 'Admin', username: 'root', passwordSecret: 'root_password' }];
  f.current.value = { ...f.metadata, installedVersion: '2.0.0',
    credentials: [{ label: 'Administrator', username: 'admin', passwordSecret: 'api_key' }] };
  await f.provider.restore(f.record);
  assert.deepEqual(f.removedSecrets, [], 'an update that generated nothing deletes nothing');
  assert.deepEqual(f.saved.at(-1)!.credentials, [{ label: 'Admin', username: 'root', passwordSecret: 'root_password' }]);
});
