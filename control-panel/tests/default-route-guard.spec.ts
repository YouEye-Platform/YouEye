import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, rmSync, symlinkSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CADDY_APP_ACL } from '../src/lib/incus/app-network-caddy-nic';
import { connectionInterface, integrationAclName } from '../src/lib/incus/connection-nic';
import {
  createDefaultRouteGuard, defaultRouteRepairScript, ETH0_UNADDRESSED, GATEWAY_OFF_ETH0, NO_IP_TOOL, LATE_LEASE_CHECK_MS, RESTORE_FAILED, SIDE_LEASE_WAIT_MS, sideInterfaces,
  type GuardDeps, type GuardInstance,
} from '../src/lib/incus/default-route-guard';
import { runDefaultRouteWatch } from '../src/lib/incus/default-route-watch';
import { clientFrame, instanceOfSource, lifecycleEventOf, parseFrames, watchLifecycleEvents, type LifecycleEvent } from '../src/lib/incus/incus-events';

const peerNic = connectionInterface('qbittorrent');

function sonarr(status = 'Running'): GuardInstance {
  return {
    name: 'app-sonarr', type: 'container', status,
    expanded_devices: {
      eth0: { type: 'nic', network: 'yeapp2', name: 'eth0' },
      'net-qbittorrent': { type: 'nic', network: 'yeapp1', name: peerNic, 'security.acls': integrationAclName('app-sonarr', 'qbittorrent') },
      root: { type: 'disk', path: '/', pool: 'default' },
    },
  };
}

test('side interfaces: connection NICs with their grant ACL and Caddy app NICs, never eth0 or foreign NICs', () => {
  assert.deepEqual(sideInterfaces(sonarr()), [peerNic]);
  const caddy: GuardInstance = {
    name: 'youeye-caddy', type: 'container',
    devices: {
      eth0: { type: 'nic', network: 'incusbr0', name: 'eth0' },
      'net-sonarr': { type: 'nic', network: 'yeapp2', name: 'eth-d377d500e1e', 'security.acls': CADDY_APP_ACL },
      'net-qbittorrent': { type: 'nic', network: 'yeapp1', name: 'eth-e851219b75c', 'security.acls': CADDY_APP_ACL },
    },
  };
  assert.deepEqual(sideInterfaces(caddy), ['eth-d377d500e1e', 'eth-e851219b75c']);
  const foreign: GuardInstance = {
    name: 'app-sonarr', type: 'container',
    devices: {
      // Another grant's ACL, an unscoped NIC, a name outside the form, a non-NIC device.
      'net-qbittorrent': { type: 'nic', name: peerNic, 'security.acls': integrationAclName('app-radarr', 'qbittorrent') },
      'net-lan': { type: 'nic', name: 'eth-0123456789a' },
      'net-x': { type: 'nic', name: 'eth0', 'security.acls': CADDY_APP_ACL },
      'net-y': { type: 'nic', name: "eth-a';reboot", 'security.acls': CADDY_APP_ACL },
      'net-z': { type: 'disk', name: peerNic, 'security.acls': CADDY_APP_ACL },
    },
  };
  assert.deepEqual(sideInterfaces(foreign), []);
});

test('the repair script rejects anything but side names and an IPv4 gateway', () => {
  assert.throws(() => defaultRouteRepairScript(['eth0'], '10.76.0.33'));
  assert.throws(() => defaultRouteRepairScript(["eth-1';x"], '10.76.0.33'));
  assert.throws(() => defaultRouteRepairScript([peerNic], '10.0.0.1; reboot'));
});

// The repair script, run in a real shell with a fake `ip` that keeps the route table in a file (busybox output form).
function runRepair(routes: string[], sides: string[], gateway = '10.76.0.33', options: { withIp?: boolean; eth0Addressed?: boolean; addFails?: boolean; gatewayOnEth0?: boolean; addRaced?: boolean; racedRoute?: string } = {}) {
  const { withIp = true, eth0Addressed = true, addFails = false, gatewayOnEth0 = true, addRaced = false } = options;
  const racedRoute = options.racedRoute ?? `default via ${gateway} dev eth0`;
  const dir = mkdtempSync(join(tmpdir(), 'ye198-'));
  try {
    const table = join(dir, 'routes');
    writeFileSync(table, routes.map((route) => `${route}\n`).join(''));
    if (withIp) {
      writeFileSync(join(dir, 'ip'), [
        '#!/bin/sh',
        `T='${table}'`,
        '[ "$1" = -4 ] && shift',
        `[ "$1" = addr ] && { ${eth0Addressed ? 'echo "    inet 10.76.0.34/27 scope global eth0"' : 'true'}; exit 0; }`,
        '[ "$1" = route ] || exit 1; shift',
        'case "$1" in',
        '  show) cat "$T" ;;',
        // get <address>: on eth0's subnet, or (a gateway from another subnet) through whatever default there is.
        `  get) ${gatewayOnEth0 ? 'echo "$2 dev eth0 src 10.76.0.34 uid 0"' : 'echo "$2 via 10.76.0.1 dev eth-e851219b75c src 10.76.0.3 uid 0"'} ;;`,
        // del default dev X: the first default route through X, else fail as ip does.
        '  del) [ "$2 $3" = "default dev" ] || exit 1; awk -v IF="$4" \'{if(!done&&$1=="default"){for(i=1;i<NF;i++) if($i=="dev"&&$(i+1)==IF){done=1;next}} print} END{exit done?0:2}\' "$T" > "$T.n" || { rm -f "$T.n"; exit 2; }; mv "$T.n" "$T" ;;',
        // addRaced: another repair adds the eth0 default just before this one, so this add fails as "exists".
        `  add) ${addFails ? 'exit 2;' : ''} ${addRaced ? `echo "${racedRoute}" >> "$T"; exit 2;` : ''} shift; grep -q "^default " "$T" && [ "$1" = default ] && exit 2; echo "$*" >> "$T" ;;`,
        '  *) exit 1 ;;',
        'esac',
      ].join('\n'));
      chmodSync(join(dir, 'ip'), 0o755);
    }
    // Only the tools the script and the fake use: never this machine's own `ip`.
    for (const tool of ['cat', 'grep', 'awk', 'mv', 'rm']) {
      const found = spawnSync('/bin/sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
      symlinkSync(found, join(dir, tool));
    }
    const run = spawnSync('/bin/sh', ['-c', defaultRouteRepairScript(sides, gateway)], {
      env: { PATH: dir }, encoding: 'utf8',
    });
    const after = readFileSync(table, 'utf8').split('\n').map((line) => line.trimEnd()).filter(Boolean);
    return { exit: run.status, stdout: run.stdout.trim(), routes: after };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('repair leaves the routes alone when the gateway is not reached through eth0 (a recreated subnet, YE-211)', () => {
  const routes = [`default via 10.76.0.1 dev ${peerNic} `, '10.76.0.32/27 dev eth0 scope link  src 10.76.0.34 '];
  const off = runRepair(routes, [peerNic], '10.77.0.1', { gatewayOnEth0: false });
  assert.deepEqual([off.exit, off.stdout], [GATEWAY_OFF_ETH0, '']);
  assert.deepEqual(off.routes, routes.map((route) => route.trimEnd()), 'the side default stays: nothing would replace it');
});

test('repair: a default route through the peer is removed and eth0 gets it back', () => {
  const result = runRepair([
    `default via 10.76.0.1 dev ${peerNic} `,
    `10.76.0.0/27 dev ${peerNic} scope link  src 10.76.0.3 `,
    '10.76.0.32/27 dev eth0 scope link  src 10.76.0.34 ',
  ], [peerNic], '10.76.0.33');
  assert.equal(result.exit, 0);
  assert.deepEqual(result.routes, [
    `10.76.0.0/27 dev ${peerNic} scope link  src 10.76.0.3`,
    '10.76.0.32/27 dev eth0 scope link  src 10.76.0.34',
    'default via 10.76.0.33 dev eth0',
  ]);
  assert.match(result.stdout, new RegExp(`removed the default route through ${peerNic}\nrestored the default route through eth0`));
});

test('repair never touches the eth0 default, and changes nothing on a container whose routes are right', () => {
  const right = ['default via 10.76.0.33 dev eth0 ', `10.76.0.0/27 dev ${peerNic} scope link  src 10.76.0.3 `];
  const unchanged = runRepair(right, [peerNic], '10.76.0.33');
  assert.deepEqual([unchanged.exit, unchanged.stdout], [0, '']);
  assert.deepEqual(unchanged.routes, right.map((route) => route.trim()));
  // Both defaults present (a second metric): only the side one goes.
  const both = runRepair(['default via 10.76.0.33 dev eth0 ', `default via 10.76.0.1 dev ${peerNic} metric 5 `], [peerNic], '10.76.0.33');
  assert.deepEqual(both.routes, ['default via 10.76.0.33 dev eth0']);
  assert.equal(both.stdout, `removed the default route through ${peerNic}`);
  // A name that is a prefix of the side NIC's is not matched.
  const prefix = runRepair(['default via 10.76.0.1 dev eth-e851219b75 '], ['eth-e851219b7'], '10.76.0.33');
  assert.deepEqual(prefix.routes, ['default via 10.76.0.1 dev eth-e851219b75']);
});

test('repair never leaves a container without the default route it had; without ip it changes nothing', () => {
  // eth0 without its address yet: the side default stays for the retry.
  const unaddressed = runRepair([`default via 10.76.0.1 dev ${peerNic} `], [peerNic], '10.76.0.33', { eth0Addressed: false });
  assert.deepEqual([unaddressed.exit, unaddressed.routes], [ETH0_UNADDRESSED, [`default via 10.76.0.1 dev ${peerNic}`]]);
  // The eth0 default can't be added (a gateway off eth0's subnet): said, and a failure.
  const refused = runRepair([`default via 10.76.0.1 dev ${peerNic} `], [peerNic], '10.76.0.33', { addFails: true });
  assert.equal(refused.exit, RESTORE_FAILED);
  assert.match(refused.stdout, /could not restore the default route through eth0/);
  const noIp = runRepair([`default via 10.76.0.1 dev ${peerNic} `], [peerNic], '10.76.0.33', { withIp: false });
  assert.equal(noIp.exit, NO_IP_TOOL);
  assert.deepEqual(noIp.routes, [`default via 10.76.0.1 dev ${peerNic}`]);
});

test('two repairs of one start racing to add the eth0 default end without a false failure (YE-223)', () => {
  // The late check and the guard's own repair both removed the side default; the other one added eth0's first.
  const raced = runRepair([`default via 10.76.0.1 dev ${peerNic} `], [peerNic], '10.76.0.33', { addRaced: true });
  assert.equal(raced.exit, 0);
  assert.doesNotMatch(raced.stdout, /could not restore/);
  assert.deepEqual(raced.routes, ['default via 10.76.0.33 dev eth0']);
});

test('the race tolerance accepts only a default through eth0, never a side default that came meanwhile (YE-224)', () => {
  const side = runRepair([`default via 10.76.0.1 dev ${peerNic} `], [peerNic], '10.76.0.33',
    { addRaced: true, racedRoute: `default via 10.76.0.1 dev ${peerNic}` });
  assert.equal(side.exit, RESTORE_FAILED, 'a late side default is reported, and the late check repairs it');
  assert.match(side.stdout, /could not restore the default route through eth0/);
});

// A fake Incus for the guard: one instance, its state (pid, addressed NICs), exec results and a log.
function fakeIncus(options: { exit?: number; stdout?: string; addressedAfter?: number; instances?: GuardInstance[] } = {}) {
  const instances = options.instances ?? [sonarr()];
  const execs: Array<{ name: string; script: string }> = [];
  const logs: string[] = [];
  const sleeps: number[] = [];
  const pids: Record<string, number> = Object.fromEntries(instances.map((instance, index) => [instance.name, 100 + index]));
  let stateReads = 0;
  const deps: GuardDeps = {
    incus: async <T,>(_method: string, path: string) => {
      const ok = (metadata: unknown) => ({ type: 'sync', status_code: 200, metadata: structuredClone(metadata) as T });
      if (path === '/1.0/instances?recursion=1') return ok(instances);
      if (path.startsWith('/1.0/networks/')) return ok({ config: { 'ipv4.address': '10.76.0.33/27' } });
      const state = /^\/1\.0\/instances\/([^/]+)\/state$/.exec(path);
      if (state) {
        stateReads++;
        const name = decodeURIComponent(state[1]);
        const ready = stateReads > (options.addressedAfter ?? 0);
        const network: Record<string, unknown> = { eth0: { addresses: [{ family: 'inet', address: '10.76.0.34' }] } };
        if (ready) network[peerNic] = { addresses: [{ family: 'inet', address: '10.76.0.3' }] };
        return ok({ pid: pids[name], network });
      }
      const one = /^\/1\.0\/instances\/([^/?]+)$/.exec(path);
      const instance = one && instances.find((candidate) => candidate.name === decodeURIComponent(one[1]));
      return instance ? ok(instance) : { type: 'error', status_code: 404, error: 'not found' };
    },
    exec: async (name, script) => {
      execs.push({ name, script });
      return { exitCode: options.exit ?? 0, stdout: options.stdout ?? '', stderr: '' };
    },
    sleep: async (ms) => { sleeps.push(ms); },
    log: (message) => { logs.push(message); },
  };
  return { deps, execs, logs, sleeps, pids, instances };
}

test('after a start the guard waits for every lease, then repairs twice, with the gateway of its own bridge', async () => {
  const incus = fakeIncus({ addressedAfter: 3, stdout: `removed the default route through ${peerNic}` });
  const guard = createDefaultRouteGuard(incus.deps);
  assert.equal(await guard.settleAndRepair('app-sonarr', 'instance-started'), 'repaired');
  assert.deepEqual(incus.sleeps, [1_000, 1_000, 1_000, 1_000, 15_000]);
  assert.equal(incus.execs.length, 2);
  assert.ok(incus.execs[0].script.includes("dev eth0") && incus.execs[0].script.includes("'10.76.0.33'"));
  assert.match(incus.logs[0], /app-sonarr \(instance-started\): removed the default route through/);
});

test('the guard skips stopped containers and containers without side NICs; no ip is logged once', async () => {
  const stopped = fakeIncus({ instances: [sonarr('Stopped')] });
  assert.equal(await createDefaultRouteGuard(stopped.deps).settleAndRepair('app-sonarr', 'x'), 'skipped');
  const plain = fakeIncus({ instances: [{ name: 'app-sonarr', type: 'container', status: 'Running', devices: { eth0: { type: 'nic', name: 'eth0' } } }] });
  assert.equal(await createDefaultRouteGuard(plain.deps).settleAndRepair('app-sonarr', 'x'), 'skipped');
  assert.equal(stopped.execs.length + plain.execs.length, 0);
  const noIp = fakeIncus({ exit: NO_IP_TOOL });
  const guard = createDefaultRouteGuard(noIp.deps);
  assert.equal(await guard.settleAndRepair('app-sonarr', 'x'), 'no-ip');
  assert.equal(await guard.settleAndRepair('app-sonarr', 'x'), 'no-ip');
  assert.deepEqual(noIp.logs, ['app-sonarr has no ip command; its default route is not checked']);
  // A failing exec is logged, tried again three times 30 s apart, and never thrown.
  const failing = fakeIncus();
  failing.deps.exec = async () => { throw new Error('exec refused'); };
  assert.equal(await createDefaultRouteGuard(failing.deps).settleAndRepair('app-sonarr', 'x'), 'failed');
  assert.equal(failing.logs.length, 4);
  assert.match(failing.logs[0], /could not check the default route of app-sonarr: exec refused/);
  assert.deepEqual(failing.sleeps.filter((ms) => ms === 30_000).length, 3);
  // A missing shell counts as unsupported, logged once.
  const noShell = fakeIncus({ exit: 127 });
  assert.equal(await createDefaultRouteGuard(noShell.deps).settleAndRepair('app-sonarr', 'x'), 'no-ip');
  assert.deepEqual(noShell.logs, ['app-sonarr has no shell; its default route is not checked']);
});

test('a container whose app an operation holds is left alone until the operation ends', async () => {
  // Held for three polls (a restart or an update being finished at start), then free: repaired after it.
  const incus = fakeIncus();
  let polls = 0;
  incus.deps.busy = () => polls++ < 3;
  assert.equal(await createDefaultRouteGuard(incus.deps).settleAndRepair('app-sonarr', 'instance-started'), 'unchanged');
  assert.deepEqual(incus.sleeps.slice(0, 3), [2_000, 2_000, 2_000]);
  assert.equal(incus.execs.length, 2);
  // Held for good: nothing runs in the container, and that is said once.
  const held = fakeIncus();
  held.deps.busy = () => true;
  assert.equal(await createDefaultRouteGuard(held.deps).settleAndRepair('app-sonarr', 'instance-started'), 'skipped');
  assert.equal(held.execs.length, 0);
  assert.deepEqual(held.logs, ['app-sonarr stayed busy with an app operation; its default route is checked at its next start']);
  // Taken between the first repair and the late one: the late one is left to the operation.
  const taken = fakeIncus();
  taken.deps.busy = () => taken.execs.length > 0;
  assert.equal(await createDefaultRouteGuard(taken.deps).settleAndRepair('app-sonarr', 'instance-started'), 'skipped');
  assert.equal(taken.execs.length, 1);
});

test('a gateway off eth0 is left as it is: said once, not retried, tried again at the next start (YE-211)', async () => {
  const incus = fakeIncus({ exit: GATEWAY_OFF_ETH0 });
  const guard = createDefaultRouteGuard(incus.deps);
  assert.equal(await guard.settleAndRepair('app-sonarr', 'instance-started'), 'left');
  assert.equal(incus.execs.length, 1, 'no retries and no late repair');
  assert.equal(incus.sleeps.filter((ms) => ms >= 15_000).length, 0);
  assert.equal(await guard.settleAndRepair('app-sonarr', 'instance-started'), 'left');
  assert.equal(incus.logs.length, 1);
  assert.match(incus.logs[0], /app-sonarr: the gateway 10\.76\.0\.33 of its own network is not reached through eth0/);
  // Recorded like a repair: the sweep leaves it until the container starts again.
  const before = incus.execs.length;
  await guard.sweep();
  assert.equal(incus.execs.length, before);
  incus.pids['app-sonarr'] = 4242;
  await guard.sweep();
  assert.equal(incus.execs.length, before + 1);
});

test("an operation's own start is repaired at once, even while the app is held (YE-220)", async () => {
  const incus = fakeIncus({ addressedAfter: 2, stdout: `removed the default route through ${peerNic}` });
  incus.deps.busy = () => true; // the update holds the app: the event-driven repair would wait for the hold to end
  const guard = createDefaultRouteGuard(incus.deps);
  assert.equal(await guard.repairAfterOperationStart('app-sonarr', 'app update start'), 'repaired');
  assert.equal(incus.execs.length, 1, 'repaired before returning to the update (its health check comes next)');
  assert.deepEqual(incus.sleeps.slice(0, 3), [1_000, 1_000, 1_000], 'after the leases were in');
  assert.match(incus.logs[0], /app-sonarr \(app update start\): removed the default route through/);
  // The late check runs in the background, still on the same start.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(incus.execs.length, 2);
  // The start is recorded: a sweep leaves it alone.
  await guard.sweep();
  assert.equal(incus.execs.length, 2);
});

test('a side NIC that gets no lease is waited for 10 s after eth0, not 40 s (YE-223)', async () => {
  // eth0 has its lease at once; the side NIC never gets one (it carries no default route then).
  const incus = fakeIncus({ addressedAfter: 1_000 });
  const guard = createDefaultRouteGuard(incus.deps);
  await guard.repairAfterOperationStart('app-sonarr', 'app update start');
  const waited = incus.sleeps.filter((ms) => ms === 1_000).length;
  assert.equal(SIDE_LEASE_WAIT_MS, 10_000);
  assert.equal(waited, 11, 'ten 1 s polls after eth0, then the 1 s settle');
  assert.equal(incus.execs.length, 1, 'the repair still runs');
});

test('a side NIC still without a lease gets one more check 30 s after the late one, past DHCP\'s 30 s (YE-224)', async () => {
  // No lease on the side NIC: the start's repair, the late check at 15 s, and one more at 45 s.
  const noLease = fakeIncus({ addressedAfter: 1_000 });
  assert.equal(await createDefaultRouteGuard(noLease.deps).settleAndRepair('app-sonarr', 'instance-started'), 'unchanged');
  assert.equal(LATE_LEASE_CHECK_MS, 30_000);
  assert.deepEqual(noLease.sleeps.filter((ms) => ms > 1_000), [15_000, 30_000]);
  assert.equal(noLease.execs.length, 3);
  // With every lease in, as before: one late check.
  const leased = fakeIncus({ addressedAfter: 0 });
  await createDefaultRouteGuard(leased.deps).settleAndRepair('app-sonarr', 'instance-started');
  assert.deepEqual(leased.sleeps.filter((ms) => ms > 1_000), [15_000]);
  assert.equal(leased.execs.length, 2);
  // An operation's start: the same two late checks in the background, on the same start only.
  const op = fakeIncus({ addressedAfter: 1_000 });
  await createDefaultRouteGuard(op.deps).repairAfterOperationStart('app-sonarr', 'app update start');
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(op.execs.length, 3);
});

test('the late check never touches a container the operation restarted meanwhile (YE-220)', async () => {
  const incus = fakeIncus();
  const guard = createDefaultRouteGuard(incus.deps);
  let restart!: () => void;
  const restarted = new Promise<void>((resolve) => { restart = resolve; });
  incus.deps.sleep = async (ms) => {
    incus.sleeps.push(ms);
    if (ms === 15_000) { incus.pids['app-sonarr'] = 4242; restart(); }
  };
  await guard.repairAfterOperationStart('app-sonarr', 'app rollback start');
  await restarted;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(incus.execs.length, 1, 'another start: left to its own repair');
});

test('an operation start without side NICs costs one read; a failed repair is not recorded (YE-220)', async () => {
  const plain = fakeIncus({ instances: [{ name: 'app-sonarr', type: 'container', status: 'Running', devices: { eth0: { type: 'nic', name: 'eth0' } } }] });
  assert.equal(await createDefaultRouteGuard(plain.deps).repairAfterOperationStart('app-sonarr', 'app update start'), 'skipped');
  assert.deepEqual([plain.execs.length, plain.sleeps.length], [0, 0]);
  const failing = fakeIncus({ exit: 1 });
  const guard = createDefaultRouteGuard(failing.deps);
  assert.equal(await guard.repairAfterOperationStart('app-sonarr', 'app update start'), 'failed');
  assert.equal(failing.execs.length, 1, "one attempt: the operation's health check decides");
  failing.deps.exec = async (name, script) => { failing.execs.push({ name, script }); return { exitCode: 0, stdout: '', stderr: '' }; };
  await guard.sweep();
  assert.equal(failing.execs.length, 3, 'not recorded: the next sweep repairs it');
});

test('the sweep repairs a container only when its init pid changed; schedules for one container fold', async () => {
  const incus = fakeIncus();
  const guard = createDefaultRouteGuard(incus.deps);
  await guard.sweep();
  assert.equal(incus.execs.length, 2);
  await guard.sweep();
  assert.equal(incus.execs.length, 2, 'same pid: nothing to do');
  incus.pids['app-sonarr'] = 999;
  await guard.sweep();
  assert.equal(incus.execs.length, 4, 'restarted: repaired again');
  // A failed repair records no pid: the next sweep tries again; one that then works records it.
  let fail = true;
  incus.deps.exec = async (name, script) => {
    incus.execs.push({ name, script });
    return fail ? { exitCode: ETH0_UNADDRESSED, stdout: '', stderr: '' } : { exitCode: 0, stdout: '', stderr: '' };
  };
  incus.pids['app-sonarr'] = 1000;
  await guard.sweep();
  assert.equal(incus.execs.length, 8, 'four attempts, all failed');
  fail = false;
  await guard.sweep();
  assert.equal(incus.execs.length, 10, 'tried again, and went through');
  await guard.sweep();
  assert.equal(incus.execs.length, 10, 'recorded now');
  const before = incus.execs.length;
  const first = guard.schedule('app-sonarr', 'a');
  const second = guard.schedule('app-sonarr', 'b');
  const third = guard.schedule('app-sonarr', 'c');
  await Promise.all([first, second, third]);
  assert.equal(incus.execs.length - before, 4, 'three calls while one ran: one more round, not three');
});

test('websocket frames: lengths, fragments, masks and control replies', () => {
  const text = (payload: string, fin = true, opcode = 1) => {
    const body = Buffer.from(payload);
    const header = body.length < 126 ? Buffer.from([(fin ? 0x80 : 0) | opcode, body.length])
      : Buffer.from([(fin ? 0x80 : 0) | opcode, 126, body.length >> 8, body.length & 0xff]);
    return Buffer.concat([header, body]);
  };
  const long = 'x'.repeat(300);
  const all = Buffer.concat([text('{"a":1}'), text(long), text('par', false), text('t', true, 0)]);
  const { frames, rest } = parseFrames(Buffer.concat([all, all.subarray(0, 3)]));
  assert.deepEqual(frames.map((frame) => [frame.opcode, frame.fin, frame.payload.toString()]), [
    [1, true, '{"a":1}'], [1, true, long], [1, false, 'par'], [0, true, 't'],
  ]);
  assert.equal(rest.length, 3);
  const pong = parseFrames(clientFrame(0xa, Buffer.from('ping!'))).frames[0];
  assert.deepEqual([pong.opcode, pong.payload.toString()], [0xa, 'ping!']);
  assert.deepEqual(lifecycleEventOf('{"type":"lifecycle","project":"default","metadata":{"action":"instance-started","source":"/1.0/instances/app-sonarr"}}'),
    { action: 'instance-started', source: '/1.0/instances/app-sonarr', project: 'default' });
  assert.equal(lifecycleEventOf('{"type":"logging","metadata":{}}'), undefined);
  assert.equal(lifecycleEventOf('not json'), undefined);
  assert.equal(instanceOfSource('/1.0/instances/app-sonarr?project=default'), 'app-sonarr');
  assert.equal(instanceOfSource('/1.0/instances/app-sonarr/snapshots/s1'), undefined);
});

// A local WebSocket server standing in for Incus's event endpoint.
function fakeEventServer(path: string, behaviour: 'ok' | 'refuse') {
  const server = createServer((socket) => {
    let request = '';
    socket.on('data', (chunk) => {
      request += chunk.toString();
      if (!request.includes('\r\n\r\n')) return;
      if (behaviour === 'refuse') {
        socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
        return;
      }
      assert.match(request, /^GET \/1\.0\/events\?type=lifecycle HTTP\/1\.1\r\n/);
      const key = /Sec-WebSocket-Key: (\S+)/.exec(request)![1];
      const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      const event = (action: string, source: string) => {
        const body = Buffer.from(JSON.stringify({ type: 'lifecycle', project: 'default', metadata: { action, source } }));
        return Buffer.concat([Buffer.from([0x81, 126, body.length >> 8, body.length & 0xff]), body]);
      };
      setTimeout(() => socket.write(Buffer.concat([
        Buffer.from([0x89, 0]), // ping
        event('instance-stopped', '/1.0/instances/app-sonarr'),
        event('instance-started', '/1.0/instances/app-sonarr'),
      ])), 20);
      request = '';
    });
  });
  return new Promise<typeof server>((resolve) => server.listen(path, () => resolve(server)));
}

test('the watch sweeps when the stream opens and repairs after an instance-started event', { timeout: 10_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ye198-ws-'));
  const path = join(dir, 'incus.sock');
  const server = await fakeEventServer(path, 'ok');
  const incus = fakeIncus();
  const stop = new AbortController();
  const repaired: string[] = [];
  incus.deps.exec = async (name) => {
    repaired.push(name);
    if (repaired.length >= 4) setTimeout(() => stop.abort(), 10);
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  // Instant, but yielding: the periodic sweep must not starve the timers this test stops with.
  incus.deps.sleep = () => new Promise((resolve) => setImmediate(resolve));
  try {
    await runDefaultRouteWatch({ ...incus.deps, open: (onReady) => connect(path, onReady), waitForIncus: async () => {} }, undefined, stop.signal);
    // Two from the opening sweep, two from the event (the stopped event does nothing); the later sweeps see the same
    // pid and do nothing.
    assert.deepEqual(repaired, ['app-sonarr', 'app-sonarr', 'app-sonarr', 'app-sonarr']);
    // The moment the stream opens is logged: after a reboot it bounds how long the apps' routes stay wrong.
    assert.equal(incus.logs[0], 'watching Incus lifecycle events');
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the watch falls back to sweeping while the event stream is refused', { timeout: 10_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ye198-ws-'));
  const path = join(dir, 'incus.sock');
  const server = await fakeEventServer(path, 'refuse');
  const incus = fakeIncus();
  const stop = new AbortController();
  let sweeps = 0;
  const sleeps: number[] = [];
  incus.deps.sleep = async (ms) => {
    sleeps.push(ms);
    if (ms === 30_000 && ++sweeps === 2) stop.abort();
  };
  try {
    await runDefaultRouteWatch({ ...incus.deps, open: (onReady) => connect(path, onReady), waitForIncus: async () => {} }, undefined, stop.signal);
    assert.equal(sweeps, 2);
    assert.equal(incus.execs.length, 2, 'the first sweep repaired; the second saw the same pid');
    assert.equal(incus.logs.filter((line) => line.startsWith('Incus event stream unavailable')).length, 1);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the hot-plug path repairs right away', async () => {
  const incus = fakeIncus();
  assert.equal(await createDefaultRouteGuard(incus.deps).repairNow('app-sonarr', 'connection activated'), 'unchanged');
  assert.equal(incus.execs.length, 1);
  assert.equal(incus.sleeps.length, 0);
});


// A raw server for the stream tests: completes the handshake, then runs `script` with the socket and what it received.
function rawEventServer(path: string, script: (socket: import('node:net').Socket, received: Buffer[]) => void) {
  const server = createServer((socket) => {
    let request = '';
    const received: Buffer[] = [];
    let open = false;
    socket.on('data', (chunk) => {
      if (open) { received.push(chunk); return; }
      request += chunk.toString('latin1');
      if (!request.includes('\r\n\r\n')) return;
      open = true;
      const key = /Sec-WebSocket-Key: (\S+)/.exec(request)![1];
      const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      script(socket, received);
    });
  });
  return new Promise<typeof server>((resolve) => server.listen(path, () => resolve(server)));
}

test('the stream joins a message fragmented over several chunks, answers a ping between fragments, and closes', { timeout: 10_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ye198-ws-'));
  const path = join(dir, 'incus.sock');
  const body = Buffer.from(JSON.stringify({ type: 'lifecycle', metadata: { action: 'instance-restarted', source: '/1.0/instances/youeye-caddy' } }));
  const half = Math.floor(body.length / 2);
  let serverReceived: Buffer[] = [];
  const server = await rawEventServer(path, (socket, received) => {
    serverReceived = received;
    const first = Buffer.concat([Buffer.from([0x01, half]), body.subarray(0, half)]); // text, not final
    const ping = Buffer.from([0x89, 4, 0x70, 0x69, 0x6e, 0x67]); // "ping"
    const last = Buffer.concat([Buffer.from([0x80, body.length - half]), body.subarray(half)]); // continuation, final
    const all = Buffer.concat([first, ping, last]);
    // One byte at a time: every frame arrives split.
    let i = 0;
    const tick = setInterval(() => {
      if (i < all.length) { socket.write(all.subarray(i, i + 1)); i++; return; }
      clearInterval(tick);
      setTimeout(() => socket.write(Buffer.from([0x88, 0])), 20); // close
    }, 1);
  });
  const events: LifecycleEvent[] = [];
  try {
    const stream = watchLifecycleEvents((onReady) => connect(path, onReady), (event) => events.push(event), () => {});
    await stream.closed;
    assert.deepEqual(events.map((event) => [event.action, event.source]), [['instance-restarted', '/1.0/instances/youeye-caddy']]);
    const replies = parseFrames(Buffer.concat(serverReceived)).frames;
    assert.deepEqual(replies.map((frame) => [frame.opcode, frame.payload.toString()]), [[0xa, 'ping'], [0x8, '']]);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a quiet stream is pinged, and one that does not answer ends so the watch reconnects', { timeout: 10_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ye198-ws-'));
  const path = join(dir, 'incus.sock');
  let serverReceived: Buffer[] = [];
  const server = await rawEventServer(path, (_socket, received) => { serverReceived = received; }); // never answers
  try {
    const started = Date.now();
    const stream = watchLifecycleEvents((onReady) => connect(path, onReady), () => {}, () => {}, { pingAfterMs: 50, answerWithinMs: 50 });
    await stream.closed;
    assert.ok(Date.now() - started >= 100);
    assert.equal(parseFrames(Buffer.concat(serverReceived)).frames[0]?.opcode, 0x9);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// YE-214: with Incus listening at the first try (YE-207) the stream opens while Incus is still starting the apps.
// A stream that delivers no events at all stands for a start event sent before the subscription was live.
async function missedStart(runningFromListCall: number) {
  const dir = mkdtempSync(join(tmpdir(), 'ye214-ws-'));
  const path = join(dir, 'incus.sock');
  const server = await rawEventServer(path, () => {}); // opens, then never sends an event
  const incus = fakeIncus();
  const sonarr = incus.instances[0];
  sonarr.status = 'Stopped';
  const stop = new AbortController();
  let listCalls = 0;
  const sleeps: number[] = [];
  const incusCall = incus.deps.incus;
  incus.deps.incus = async (method, path) => {
    if (path === '/1.0/instances?recursion=1' && ++listCalls >= runningFromListCall) sonarr.status = 'Running';
    return incusCall(method, path);
  };
  incus.deps.exec = async (name, script) => {
    incus.execs.push({ name, script });
    if (incus.execs.length >= 2) setTimeout(() => stop.abort(), 10);
    // The first repair finds the side default; the late one finds the routes right.
    return { exitCode: 0, stdout: incus.execs.length === 1 ? `removed the default route through ${peerNic}` : '', stderr: '' };
  };
  incus.deps.sleep = (ms) => { sleeps.push(ms); return new Promise((resolve) => setImmediate(resolve)); };
  try {
    await runDefaultRouteWatch({ ...incus.deps, open: (onReady) => connect(path, onReady), waitForIncus: async () => {} }, undefined, stop.signal);
    const repairs = incus.logs.filter((line) => line.startsWith('app-sonarr ('));
    return { repairs, sleeps, execs: incus.execs.length };
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('an app not yet Running at the opening sweep is repaired by the sweep 5 s later (YE-214)', { timeout: 10_000 }, async () => {
  const { repairs, sleeps, execs } = await missedStart(2);
  assert.deepEqual(sleeps.slice(0, 3), [5_000, 15_000, 30_000], 'follow-up sweeps at +5, +15 and +30 s from the opening');
  assert.deepEqual(repairs, [`app-sonarr (after the stream opened): removed the default route through ${peerNic}`]);
  assert.equal(execs, 2, 'the repair and its late check, once');
});

test('a start whose event came before the subscription was live is repaired by the periodic sweep (YE-214)', { timeout: 10_000 }, async () => {
  // Not Running through the opening sweep and the three follow-ups: only the minute sweep can find it.
  const { repairs, sleeps, execs } = await missedStart(5);
  assert.ok(sleeps.includes(60_000));
  assert.deepEqual(repairs, [`app-sonarr (periodic): removed the default route through ${peerNic}`], 'the minute sweep, while the stream is up');
  assert.equal(execs, 2);
});

test('close() before a socket exists (open threw) does not throw; the stream reports the error (YE-211)', async () => {
  const stream = watchLifecycleEvents(() => { throw new Error('no Incus socket'); }, () => {}, () => {});
  assert.doesNotThrow(() => stream.close());
  await assert.rejects(stream.closed, /no Incus socket/);
});
