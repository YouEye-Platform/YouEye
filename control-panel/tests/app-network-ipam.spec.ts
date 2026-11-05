import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  APP_NETWORK_IPAM_SCHEMA,
  APP_NETWORK_POOL_CANDIDATES,
  AppNetworkCapacityError,
  AppNetworkOperationConflictError,
  AppNetworkStateError,
  cidrComplement,
  cidrContains,
  cidrOverlaps,
  createLegacyImportedLease,
  createEmptyIpamState,
  formatIPv4,
  mutateIpamState,
  parseCIDR,
  parseIPv4,
  parseProcNetRoute,
  readIpamState,
  releaseLease,
  reserveLease,
  selectAppNetworkPools,
  transitionLease,
  validateAppNetworkConfig,
  validateIpamState,
  withAppNetworkOperationLock,
  writeIpamStateAtomic,
} from '../src/lib/incus/app-network-ipam';

const config = { pools: ['10.76.0.0/16', '10.77.0.0/16'], allocationPrefix: 27 };

test('bootstrap planner deterministically skips collisions and fails closed on exhaustion', () => {
  assert.deepEqual(
    selectAppNetworkPools(APP_NETWORK_POOL_CANDIDATES, ['192.168.31.0/24']),
    ['10.76.0.0/16'],
  );
  assert.deepEqual(
    selectAppNetworkPools(APP_NETWORK_POOL_CANDIDATES, ['10.76.122.0/24', '192.168.31.0/24']),
    ['10.77.0.0/16'],
  );
  assert.deepEqual(
    selectAppNetworkPools(APP_NETWORK_POOL_CANDIDATES, ['10.76.0.0/15', '10.78.0.0/15']),
    ['10.80.0.0/16'],
  );
  assert.throws(
    () => selectAppNetworkPools(['10.76.0.0/16', '10.77.0.0/16'], ['10.76.0.0/15']),
    AppNetworkCapacityError,
  );
});

test('IPv4 and CIDR math is exact across octet and pool boundaries', () => {
  for (const address of ['0.0.0.0', '10.76.0.0', '10.76.255.255', '255.255.255.255']) {
    assert.equal(formatIPv4(parseIPv4(address)), address);
  }
  assert.deepEqual(parseCIDR('10.76.255.224/27'), {
    cidr: '10.76.255.224/27',
    network: parseIPv4('10.76.255.224'),
    broadcast: parseIPv4('10.76.255.255'),
    prefix: 27,
    size: 32,
  });
  assert.equal(cidrContains('10.76.0.0/16', '10.76.255.224/27'), true);
  assert.equal(cidrContains('10.76.0.0/16', '10.77.0.0/27'), false);
  assert.equal(cidrOverlaps('10.76.0.0/27', '10.76.0.32/27'), false);
  assert.equal(cidrOverlaps('10.76.0.0/16', '10.76.128.0/17'), true);
  assert.throws(() => parseCIDR('10.76.0.1/16'), AppNetworkStateError);
  assert.deepEqual(
    validateAppNetworkConfig({ pools: ['10.77.0.0/16', '10.76.0.0/16'], allocationPrefix: 27 }).pools,
    ['10.76.0.0/16', '10.77.0.0/16'],
  );
});

test('host route parsing and explicit exclusions normalize before pool preflight', () => {
  const proc = [
    'Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT',
    'eth0\t00000000\t011FA8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0',
    'yeapp1\t00004C0A\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0',
    'eth0\t001FA8C0\t00000000\t0001\t0\t0\t100\t00FFFFFF\t0\t0\t0',
  ].join('\n');
  assert.deepEqual(parseProcNetRoute(proc), ['10.76.0.0/16', '192.168.31.0/24']);
  assert.deepEqual(validateAppNetworkConfig({
    pools: ['10.76.0.0/16'],
    allocationPrefix: 27,
    excludedCIDRs: ['172.20.0.0/16'],
  }).excludedCIDRs, ['172.20.0.0/16']);
  assert.throws(() => parseProcNetRoute(
    `${proc.split('\n')[0]}\neth0\t001FA8C0\t00000000\t0001\t0\t0\t100\tFF00FF00\t0\t0\t0`,
  ), /non-contiguous/i);
});

test('CIDR complement excludes only the app lease and never shadows its own subnet', () => {
  const complement = cidrComplement('10.76.0.0/16', '10.76.0.32/27');
  assert.ok(complement.length > 0);
  assert.equal(complement.some((cidr) => cidrOverlaps(cidr, '10.76.0.32/27')), false);
  for (const cidr of complement) assert.equal(cidrContains('10.76.0.0/16', cidr), true);
  const represented = complement.reduce((sum, cidr) => sum + parseCIDR(cidr).size, 0);
  assert.equal(represented, parseCIDR('10.76.0.0/16').size - 32);
});

test('allocator chooses lowest free opaque identity and CIDR, skips collisions, exhausts, and reuses', () => {
  const state = createEmptyIpamState({ pools: ['10.76.0.0/26'], allocationPrefix: 27 }, '2026-08-02T00:00:00Z');
  const first = reserveLease(state, {
    appId: 'first', operationId: 'op-1', requiredAddresses: 8,
    observedBridgeNames: ['yeapp1'], excludedCIDRs: ['10.76.0.0/27'], now: '2026-08-02T00:00:01Z',
  });
  assert.equal(first.bridgeName, 'yeapp2');
  assert.equal(first.cidr, '10.76.0.32/27');
  assert.throws(() => reserveLease(state, {
    appId: 'second', operationId: 'op-2', requiredAddresses: 8,
    observedBridgeNames: ['yeapp1'], excludedCIDRs: ['10.76.0.0/27'],
  }), /capacity exhausted/i);
  transitionLease(state, 'first', 'cleanup_pending');
  releaseLease(state, 'first');
  const reused = reserveLease(state, {
    appId: 'second', operationId: 'op-3', requiredAddresses: 8,
    observedBridgeNames: ['yeapp1'], excludedCIDRs: ['10.76.0.0/27'],
  });
  assert.equal(reused.bridgeName, 'yeapp2');
  assert.equal(reused.cidr, '10.76.0.32/27');
});

test('strict schema rejects corruption, overlaps, duplicates, and invalid capacity', () => {
  const state = createEmptyIpamState(config);
  reserveLease(state, { appId: 'one', operationId: 'op-1', requiredAddresses: 4 });
  const overlapping = structuredClone(state);
  overlapping.leases.push({ ...overlapping.leases[0], appId: 'two', bridgeId: 2, bridgeName: 'yeapp2' });
  assert.throws(() => validateIpamState(overlapping), /overlapping live leases/i);
  const badSchema = { ...state, schema: 'legacy' };
  assert.throws(() => validateIpamState(badSchema), /unsupported/i);
  assert.throws(() => reserveLease(createEmptyIpamState(config), {
    appId: 'too-big', operationId: 'op-big', requiredAddresses: 31,
  }), /provides 30 usable/i);
  const existing = createEmptyIpamState(config);
  reserveLease(existing, { appId: 'same-app', operationId: 'first-operation', requiredAddresses: 4 });
  assert.throws(() => reserveLease(existing, {
    appId: 'same-app', operationId: 'different-operation', requiredAddresses: 4,
  }), /already owns/i);
  assert.equal(reserveLease(existing, {
    appId: 'same-app', operationId: 'first-operation', requiredAddresses: 4,
  }).bridgeName, 'yeapp1');
});

test('explicit legacy provenance preserves exact /24 leases while new allocations remain /27', () => {
  const state = createEmptyIpamState({ pools: ['10.76.0.0/16'], allocationPrefix: 27 });
  state.leases.push(createLegacyImportedLease({
    appId: 'wiki', bridgeId: 1, requiredAddresses: 2, now: '2026-08-03T00:00:00Z',
  }));
  const valid = validateIpamState(state);
  assert.equal(valid.leases[0].cidr, '10.76.1.0/24');
  assert.equal(valid.leases[0].importedFrom, 'subnets.json/v1');

  const fresh = reserveLease(valid, {
    appId: 'new-app', operationId: 'new-operation', requiredAddresses: 4,
  });
  assert.equal(fresh.bridgeName, 'yeapp2');
  assert.equal(fresh.cidr, '10.76.0.0/27');

  for (const mutation of [
    { cidr: '10.76.1.0/27' },
    { gateway: '10.76.1.2' },
    { state: 'cleanup_pending' },
    { operationId: 'different' },
    { importedFrom: 'untrusted' },
  ]) {
    const corrupt = structuredClone(state);
    Object.assign(corrupt.leases[0], mutation);
    assert.throws(() => validateIpamState(corrupt), AppNetworkStateError);
  }
});

test('pure allocator survives 5,000 allocate/free cycles across pool boundary', () => {
  const state = createEmptyIpamState(config);
  for (let index = 0; index < 2_100; index++) {
    const lease = reserveLease(state, {
      appId: `app-${index}`, operationId: `allocate-${index}`, requiredAddresses: 4,
    });
    if (index === 2_047) assert.equal(lease.cidr, '10.76.255.224/27');
    if (index === 2_048) assert.equal(lease.cidr, '10.77.0.0/27');
  }
  for (let index = 0; index < 2_100; index++) releaseLease(state, `app-${index}`);
  for (let index = 0; index < 2_900; index++) {
    const lease = reserveLease(state, {
      appId: `reuse-${index}`, operationId: `reuse-${index}`, requiredAddresses: 4,
    });
    assert.equal(lease.bridgeId, 1);
    assert.equal(lease.cidr, '10.76.0.0/27');
    releaseLease(state, `reuse-${index}`);
  }
  assert.equal(state.leases.length, 0);
});

test('atomic store is mode 0600, never resets corrupt input, and serializes concurrent writers', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'youeye-ipam-'));
  const statePath = path.join(directory, 'networks', 'ipam.json');
  try {
    const state = createEmptyIpamState(config);
    await writeIpamStateAtomic(state, statePath);
    const storedMode = (await (await import('node:fs/promises')).stat(statePath)).mode & 0o777;
    assert.equal(storedMode, 0o600);
    await Promise.all(Array.from({ length: 32 }, (_, index) => mutateIpamState(
      { statePath, config },
      (current) => reserveLease(current, {
        appId: `parallel-${index}`, operationId: `op-${index}`, requiredAddresses: 4,
      }),
    )));
    const stored = await readIpamState({ statePath, config });
    assert.equal(stored.leases.length, 32);
    assert.equal(new Set(stored.leases.map((lease) => lease.cidr)).size, 32);
    assert.equal(new Set(stored.leases.map((lease) => lease.bridgeName)).size, 32);

    await chmod(statePath, 0o644);
    await assert.rejects(readIpamState({ statePath, config }), /mode 0600/i);
    await chmod(statePath, 0o600);

    await writeFile(statePath, '{"schema":', 'utf8');
    await chmod(statePath, 0o600);
    await assert.rejects(readIpamState({ statePath, config }), /corrupt or truncated/i);
    assert.equal(await readFile(statePath, 'utf8'), '{"schema":');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('per-app operation lock rejects the second concurrent mutation and allows safe reuse', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'youeye-app-lock-'));
  try {
    let releaseFirst!: () => void;
    const held = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const first = withAppNetworkOperationLock('notes', 'install', async () => held, { stateDirectory: directory });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await assert.rejects(
      withAppNetworkOperationLock('notes', 'remove', async () => undefined, { stateDirectory: directory }),
      AppNetworkOperationConflictError,
    );
    releaseFirst();
    await first;
    await withAppNetworkOperationLock('notes', 'retry', async () => undefined, { stateDirectory: directory });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('operation lock rejects PID reuse and removes a crash-stale owner immediately', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'youeye-stale-app-lock-'));
  try {
    const lock = path.join(directory, 'locks', 'app-notes.lock');
    await mkdir(lock, { recursive: true, mode: 0o700 });
    await writeFile(path.join(lock, 'owner.json'), `${JSON.stringify({
      pid: process.pid,
      operation: 'crashed-install',
      startedAt: new Date().toISOString(),
      bootId: (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(),
      processStartTime: '0',
    })}\n`, { mode: 0o600 });
    await withAppNetworkOperationLock('notes', 'reconcile', async () => undefined, { stateDirectory: directory });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('serialized state uses final pre-release schema name', () => {
  const state = createEmptyIpamState(config);
  assert.equal(state.schema, APP_NETWORK_IPAM_SCHEMA);
});
