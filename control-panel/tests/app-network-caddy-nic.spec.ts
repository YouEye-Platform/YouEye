import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  caddyAppNICActivationScript,
  caddyAppNICIsActive,
  caddyAppNICReleaseScript,
  planCaddyAppNIC,
  CADDY_APP_ACL,
  CADDY_APP_ACL_INGRESS,
} from '../src/lib/incus/app-network-caddy-nic';

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
  assert.deepEqual(planCaddyAppNIC('canvas-credential-fixture', 'yeapp1', devices).device, {
    ...old,
    'security.acls': CADDY_APP_ACL,
    'security.acls.default.ingress.action': 'reject',
    'security.acls.default.egress.action': 'allow',
  });
  const added = planCaddyAppNIC('canvas-credential-restore-fixture', 'yeapp2', devices);
  assert.notEqual(added.device.name, old.name);
  assert.deepEqual(devices['net-canvas-credential-fixture'], old);
});

test('Caddy app NICs admit only HTTP and HTTPS from the app network', () => {
  const { device } = planCaddyAppNIC('app-one', 'yeapp1', {});
  assert.equal(device['security.acls'], CADDY_APP_ACL);
  assert.equal(device['security.acls.default.ingress.action'], 'reject');
  assert.equal(device['security.acls.default.egress.action'], 'allow');
  assert.deepEqual(CADDY_APP_ACL_INGRESS.map(rule => [rule.action, rule.protocol, rule.destination_port, rule.source]),
    [['allow', 'tcp', '80,443', undefined]]);
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

// Fake busybox `ip` and `udhcpc` that keep one interface's state in files, so
// the real activation script runs end to end without a container.
const FAKE_IP = `#!/bin/sh
echo "ip $*" >> "$STATE/log"
case "$*" in
  "link show "*) [ -f "$STATE/link" ] ;;
  "link set "*" up") touch "$STATE/up" ;;
  "-4 addr show dev "*) [ -f "$STATE/addr" ] && echo "    inet $(cat "$STATE/addr") scope global" ; true ;;
  "-4 addr flush dev "*) rm -f "$STATE/addr" ;;
  "addr add "*) echo "$3" > "$STATE/addr" ;;
esac
`;
const FAKE_UDHCPC = `#!/bin/sh
echo "udhcpc $*" >> "$STATE/log"
while [ $# -gt 0 ]; do case "$1" in -i) IF=$2; shift ;; -s) HOOK=$2; shift ;; -p) PIDF=$2; shift ;; esac; shift; done
[ -f "$STATE/no-lease" ] && exit 1
echo 999999 > "$PIDF"
interface=$IF ip=10.76.0.30 mask=27 "$HOOK" bound
`;

function sandbox() {
  const dir = mkdtempSync(path.join(tmpdir(), 'caddy-nic-'));
  const bin = path.join(dir, 'bin');
  const state = path.join(dir, 'state');
  execFileSync('mkdir', ['-p', bin, state]);
  for (const [name, body] of [['ip', FAKE_IP], ['udhcpc', FAKE_UDHCPC]] as const) {
    writeFileSync(path.join(bin, name), body);
    chmodSync(path.join(bin, name), 0o755);
  }
  const run = (script: string) => {
    try {
      execFileSync('sh', ['-c', script], { env: { PATH: `${bin}:/usr/bin:/bin`, STATE: state } });
      return 0;
    } catch (error) {
      return (error as { status: number }).status;
    }
  };
  const log = () => existsSync(path.join(state, 'log')) ? readFileSync(path.join(state, 'log'), 'utf8') : '';
  return { dir, state, run, log, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('a hot-plugged Caddy NIC is brought up with a DHCP address that only touches the interface', () => {
  const box = sandbox();
  try {
    writeFileSync(path.join(box.state, 'link'), '');
    const ifName = planCaddyAppNIC('actual-budget', 'yeapp1', {}).device.name;
    assert.equal(box.run(caddyAppNICActivationScript(ifName, box.dir)), 0);
    assert.ok(existsSync(path.join(box.state, 'up')));
    assert.equal(readFileSync(path.join(box.state, 'addr'), 'utf8').trim(), '10.76.0.30/27');
    const log = box.log();
    assert.match(log, new RegExp(`udhcpc -i ${ifName} -s .*youeye-app-nic\\.udhcpc -p .*youeye-udhcpc-${ifName}\\.pid -R -n`));
    assert.doesNotMatch(log, /route|resolv/);
    assert.ok(existsSync(path.join(box.dir, `youeye-udhcpc-${ifName}.pid`)));

    // Idempotent: a second run sets the link up but starts no second client.
    const before = box.log().split('udhcpc -i').length;
    assert.equal(box.run(caddyAppNICActivationScript(ifName, box.dir)), 0);
    assert.equal(box.log().split('udhcpc -i').length, before);

    // Removal stops the client and forgets its pid file.
    assert.equal(box.run(caddyAppNICReleaseScript(ifName, box.dir)), 0);
    assert.ok(!existsSync(path.join(box.dir, `youeye-udhcpc-${ifName}.pid`)));
  } finally {
    box.cleanup();
  }
});

test('activation fails loudly when no lease is obtained', () => {
  const box = sandbox();
  try {
    writeFileSync(path.join(box.state, 'link'), '');
    writeFileSync(path.join(box.state, 'no-lease'), '');
    assert.equal(box.run(caddyAppNICActivationScript('eth-0123456789a', box.dir)), 6);
    assert.ok(!existsSync(path.join(box.state, 'addr')));
  } finally {
    box.cleanup();
  }
});

test('activation scripts accept only planned interface names', () => {
  for (const bad of ['eth0; reboot', "eth-x'y", 'eth-' + 'a'.repeat(12), '']) {
    assert.throws(() => caddyAppNICActivationScript(bad), /Invalid/);
    assert.throws(() => caddyAppNICReleaseScript(bad), /Invalid/);
  }
});

test('Caddy NIC state needs the link up and an IPv4 address', () => {
  const up = { status: 'Running', network: { 'eth-a': { state: 'up', addresses: [{ family: 'inet', address: '10.76.0.30' }] } } };
  assert.equal(caddyAppNICIsActive(up, 'eth-a'), true);
  assert.equal(caddyAppNICIsActive(up, 'eth-b'), false);
  assert.equal(caddyAppNICIsActive({ network: { 'eth-a': { state: 'down', addresses: [] } } }, 'eth-a'), false);
  assert.equal(caddyAppNICIsActive({ network: { 'eth-a': { state: 'up', addresses: [{ family: 'inet6', address: 'fe80::1' }] } } }, 'eth-a'), false);
  assert.equal(caddyAppNICIsActive({ network: null }, 'eth-a'), false);
});

test('attaching Caddy activates the NIC and removing it stops the DHCP client first', async () => {
  const source = await readFile(path.join(process.cwd(), 'src/lib/incus/app-network.ts'), 'utf8');
  const add = source.slice(source.indexOf('async function addCaddyToProvedAppNetwork'), source.indexOf('async function readCaddyState'));
  assert.ok(add.indexOf('Read back Caddy NICs') < add.indexOf('await activateCaddyAppNIC(ifName, bridgeName)'));
  const activate = source.slice(source.indexOf('async function activateCaddyAppNIC'), source.indexOf('export async function removeCaddyFromAppNetwork'));
  assert.match(activate, /state\.status !== 'Running' \|\| caddyAppNICIsActive\(state, ifName\)\) return/);
  assert.match(activate, /readOnlyAudit\.getStore\(\)\) throw/);
  const remove = source.slice(source.indexOf('export async function removeCaddyFromAppNetwork'), source.indexOf('// ─── Proxy Device Management'));
  assert.ok(remove.indexOf('caddyAppNICReleaseScript(ifName)') < remove.indexOf('applyInstanceDeviceMergePatch('));
});
