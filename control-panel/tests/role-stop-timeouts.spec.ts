import assert from 'node:assert/strict';
import test from 'node:test';
import { containerOrder, fakeIncus, loadSnapshot, loadSource } from './fixtures/update-provider-harness';

function box(...running: string[]) {
  const incus = fakeIncus();
  for (const name of running) incus.addInstance(name, 'Running');
  return incus;
}

test('a credential quiesce stops the app in stop order, the database last with its long timeout', async () => {
  const incus = box('app-immich-main', 'app-immich-postgres', 'app-immich-valkey', 'app-other');
  const probe = loadSource('lib/apps/service-credential-probe.ts', (name) => ({
    '../incus/snapshot': loadSnapshot(incus),
    './container-order': containerOrder(),
  } as Record<string, unknown>)[name] ?? {});
  const containers = [
    { name: 'main', containerName: 'app-immich-main', type: 'oci', primary: true },
    { name: 'postgres', containerName: 'app-immich-postgres', type: 'oci', role: 'database' },
    { name: 'valkey', containerName: 'app-immich-valkey', type: 'oci' },
  ];
  await probe.quiesceAppCredentialRuntime(['app-immich-postgres', 'app-other', 'app-immich-valkey', 'app-immich-main'], containers);
  assert.deepEqual(incus.log, [
    'stop:app-immich-main:60', 'stop:app-immich-valkey:60', 'stop:app-immich-postgres:120', 'stop:app-other:60',
  ]);
  // Without the app's record: the given order, the default timeout.
  incus.log.length = 0;
  for (const name of ['app-immich-main', 'app-immich-postgres']) incus.instances.get(name)!.status = 'Running';
  await probe.quiesceAppCredentialRuntime(['app-immich-postgres', 'app-immich-main']);
  assert.deepEqual(incus.log, ['stop:app-immich-postgres:60', 'stop:app-immich-main:60']);
});
