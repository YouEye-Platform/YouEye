import assert from 'node:assert/strict';
import test from 'node:test';
import { planCaddyAppNIC } from '../src/lib/incus/app-network-caddy-nic';

test('two app IDs sharing the legacy prefix attach distinct bounded interfaces', () => {
  const first = planCaddyAppNIC('canvas-credential-fixture', 'yeapp1', {});
  const second = planCaddyAppNIC('canvas-credential-restore-fixture', 'yeapp2', {
    [first.deviceName]: first.device,
  });
  assert.notEqual(first.device.name, second.device.name);
  assert.equal(second.device.network, 'yeapp2');
  assert.match(second.device.name, /^eth-[a-f0-9]{11}$/);
  assert.equal(second.device.name.length, 15);
  assert.equal(planCaddyAppNIC('a'.repeat(63), 'yeapp3', {}).device.name.length, 15);
});

test('a valid legacy attachment survives while a same-prefix new app uses its own name', () => {
  const old = { type: 'nic', network: 'yeapp1', name: 'eth-canvas-cred' };
  const devices = { 'net-canvas-credential-fixture': old };
  assert.deepEqual(planCaddyAppNIC('canvas-credential-fixture', 'yeapp1', devices).device, old);
  const added = planCaddyAppNIC('canvas-credential-restore-fixture', 'yeapp2', devices);
  assert.notEqual(added.device.name, old.name);
  assert.deepEqual(devices['net-canvas-credential-fixture'], old);
});

test('a current attachment is deterministic and retained', () => {
  const plan = planCaddyAppNIC('app-one', 'yeapp1', {});
  assert.deepEqual(planCaddyAppNIC('app-one', 'yeapp1', { [plan.deviceName]: plan.device }), plan);
});

test('foreign bridges, device types and unknown interface names are rejected', () => {
  for (const device of [
    { type: 'nic', network: 'yeapp99', name: 'eth-app-one' },
    { type: 'proxy', network: 'yeapp1', name: 'eth-app-one' },
    { type: 'nic', network: 'yeapp1', name: 'unexpected' },
  ]) assert.throws(() => planCaddyAppNIC('app-one', 'yeapp1', { 'net-app-one': device }), /does not match/);
});

test('a conflicting interface is rejected without overwriting another device', () => {
  const planned = planCaddyAppNIC('app-one', 'yeapp1', {});
  const devices = { foreign: { ...planned.device, network: 'yeapp99' } };
  const original = structuredClone(devices);
  assert.throws(() => planCaddyAppNIC('app-one', 'yeapp1', devices), /already in use/);
  assert.deepEqual(devices, original);
  assert.throws(() => planCaddyAppNIC('../bad', 'yeapp1', {}), /Invalid/);
});
