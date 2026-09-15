/**
 * Session-only live scale harness.
 *
 * This deliberately calls the production allocator, bridge lifecycle, policy
 * generator, read-back verifier, and deletion path. It does not create app
 * workloads. Run only in the disposable Session VM with:
 *
 *   YOUEYE_LIVE_FIXTURE_SESSION=public-app-network-fixture \
 *     pnpm exec tsx tests/live/app-network-scale.ts create 128
 *
 * Repeat create at 256, 512, and 1024. Use `verify`, `reuse`, `concurrent`, and
 * finally `delete`. The guard prevents accidental use on an ordinary system.
 */

import assert from 'node:assert/strict';
import {
  clearAppNetworkTestSnapshot,
  createAppNetwork,
  deleteAppNetwork,
  getAppNetworkLease,
  listAppNetworks,
  markAppNetworkActive,
  prepareAppEgressAcl,
  removeAppEgressAcl,
  withAppNetworkOperationLock,
} from '../../src/lib/incus/app-network';
import { incusRequest } from '../../src/lib/incus/server';
import { firstHost, parseCIDR } from '../../src/lib/incus/app-network-ipam';

const SESSION_ID = 'public-app-network-fixture';
const SCALE_PREFIX = 'session-scale-';
const CONCURRENT_PREFIX = 'session-concurrent-';
const REUSE_ID = 'session-scale-reuse';

function requireFixtureGuard(): void {
  if (process.env.YOUEYE_LIVE_FIXTURE_SESSION !== SESSION_ID) {
    throw new Error(`Refusing live mutation without YOUEYE_LIVE_FIXTURE_SESSION=${SESSION_ID}`);
  }
  process.env.YOUEYE_TEST_HOST_ROUTE_PATH = '/proc/net/route';
  // The exact inventory itself exceeds 60 seconds at 512 bridges. Cache only
  // inside this Session-guarded process while every mutation still performs
  // target read-back and the run finishes with a fresh all-object verification.
  process.env.YOUEYE_TEST_NETWORK_SNAPSHOT_TTL_MS = '1800000';
}

function fixtureId(prefix: string, index: number): string {
  return `${prefix}${String(index).padStart(4, '0')}`;
}

function parseCount(value: string | undefined, maximum = 2048): number {
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1 || count > maximum) {
    throw new Error(`Count must be an integer from 1 through ${maximum}`);
  }
  return count;
}

function isFixtureApp(appId: string): boolean {
  return appId.startsWith(SCALE_PREFIX)
    || appId.startsWith(CONCURRENT_PREFIX)
    || appId === REUSE_ID;
}

async function runBounded<T>(
  items: T[],
  concurrency: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      await work(item);
    }
  }));
}

function scaleConcurrency(): number {
  const value = Number(process.env.YOUEYE_LIVE_SCALE_CONCURRENCY ?? 4);
  if (!Number.isInteger(value) || value < 1 || value > 32) {
    throw new Error('YOUEYE_LIVE_SCALE_CONCURRENCY must be an integer from 1 through 32');
  }
  return value;
}

async function createFixture(appId: string, knownAbsent = false): Promise<void> {
  await withAppNetworkOperationLock(appId, 'live-scale-create', async () => {
    const existing = knownAbsent ? null : await getAppNetworkLease(appId);
    if (existing?.state === 'active') return;
    if (existing) {
      try {
        await prepareAppEgressAcl(appId, { needsSharedDb: false, needsSSO: false });
        await markAppNetworkActive(appId);
        return;
      } catch {
        await removeAppEgressAcl(appId);
        await deleteAppNetwork(appId);
      }
    }
    try {
      await createAppNetwork(appId, {
        operationId: `live-scale-${appId}`,
        requiredAddresses: 8,
      });
      await prepareAppEgressAcl(appId, { needsSharedDb: false, needsSSO: false });
      await markAppNetworkActive(appId);
    } catch (error) {
      try {
        await removeAppEgressAcl(appId);
        await deleteAppNetwork(appId);
      } catch {
        // Production lifecycle retains cleanup_pending when exact cleanup is
        // uncertain; preserve the original failure and let reconciliation act.
      }
      throw error;
    }
  });
}

async function deleteFixture(appId: string): Promise<void> {
  await withAppNetworkOperationLock(appId, 'live-scale-delete', async () => {
    await removeAppEgressAcl(appId);
    await deleteAppNetwork(appId);
  });
}

async function verifyFixtureSet(expectedScaleCount?: number): Promise<Record<string, unknown>> {
  clearAppNetworkTestSnapshot();
  const all = await listAppNetworks();
  const fixtures = all.filter((lease) => isFixtureApp(lease.appId));
  const scale = fixtures.filter((lease) => lease.appId.startsWith(SCALE_PREFIX));
  if (expectedScaleCount !== undefined) assert.equal(scale.length, expectedScaleCount);
  assert.equal(new Set(fixtures.map((lease) => lease.bridgeName)).size, fixtures.length);
  assert.equal(new Set(fixtures.map((lease) => lease.subnetCIDR)).size, fixtures.length);

  await runBounded(fixtures, 16, async (lease) => {
    assert.equal(lease.state, 'active');
    const network = await incusRequest<{
      name: string;
      config?: Record<string, string>;
    }>('GET', `/1.0/networks/${lease.bridgeName}`);
    assert.equal(network.type, 'sync');
    assert.equal(network.status_code, 200);
    assert.equal(network.metadata.name, lease.bridgeName);
    assert.equal(
      network.metadata.config?.['ipv4.address'],
      `${firstHost(lease.subnetCIDR)}/${parseCIDR(lease.subnetCIDR).prefix}`,
    );
    assert.equal(network.metadata.config?.['user.youeye.kind'], 'app-network');
    assert.equal(network.metadata.config?.['user.youeye.app_id'], lease.appId);
    assert.equal(network.metadata.config?.['user.youeye.cidr'], lease.subnetCIDR);

    const acl = await incusRequest<{ egress?: Array<Record<string, string>> }>(
      'GET',
      `/1.0/network-acls/ye-app-${lease.appId}-egress`,
    );
    assert.equal(acl.type, 'sync');
    assert.equal(acl.status_code, 200);
    assert.ok((acl.metadata.egress ?? []).some((rule) =>
      rule.action === 'allow' && rule.destination === lease.subnetCIDR));
    assert.ok((acl.metadata.egress ?? []).some((rule) =>
      rule.action === 'reject' && rule.description?.startsWith('default-deny routed traffic')));
  });

  return {
    fixtureLeases: fixtures.length,
    scaleLeases: scale.length,
    lowestBridge: fixtures.map((lease) => lease.bridgeName).sort((left, right) =>
      Number(left.slice(5)) - Number(right.slice(5)))[0] ?? null,
  };
}

async function createTo(target: number): Promise<Record<string, unknown>> {
  const existing = new Map((await listAppNetworks()).map((lease) => [lease.appId, lease.state]));
  const pending = Array.from({ length: target }, (_, offset) => fixtureId(SCALE_PREFIX, offset + 1))
    .filter((appId) => existing.get(appId) !== 'active');
  const concurrency = scaleConcurrency();
  await runBounded(pending, concurrency, (appId) => createFixture(appId, !existing.has(appId)));
  return { concurrency, ...(await verifyFixtureSet(target)) };
}

async function createConcurrent(count: number): Promise<Record<string, unknown>> {
  await Promise.all(Array.from({ length: count }, (_, offset) =>
    createFixture(fixtureId(CONCURRENT_PREFIX, offset + 1))));
  return verifyFixtureSet();
}

async function proveLowestReuse(): Promise<Record<string, unknown>> {
  const leases = (await listAppNetworks())
    .filter((lease) => lease.appId.startsWith(SCALE_PREFIX))
    .sort((left, right) => left.subnet - right.subnet);
  const released = leases[0];
  if (!released) throw new Error('Create at least one scale fixture before the reuse check');

  await deleteFixture(released.appId);
  await createFixture(REUSE_ID);
  const replacement = await getAppNetworkLease(REUSE_ID);
  assert.ok(replacement);
  assert.equal(replacement.bridgeName, released.bridgeName);
  assert.equal(replacement.cidr, released.subnetCIDR);
  await deleteFixture(REUSE_ID);
  await createFixture(released.appId);
  clearAppNetworkTestSnapshot();

  return {
    reusedBridge: released.bridgeName,
    reusedCIDR: released.subnetCIDR,
    restoredAppId: released.appId,
  };
}

async function deleteAllFixtures(): Promise<Record<string, unknown>> {
  const fixtures = (await listAppNetworks()).filter((lease) => isFixtureApp(lease.appId));
  const mixedOrder = fixtures
    .filter((_, index) => index % 2 === 1)
    .concat(fixtures.filter((_, index) => index % 2 === 0).reverse());
  await runBounded(mixedOrder, scaleConcurrency(), (lease) => deleteFixture(lease.appId));
  clearAppNetworkTestSnapshot();
  const residue = (await listAppNetworks()).filter((lease) => isFixtureApp(lease.appId));
  assert.deepEqual(residue, []);
  return { deleted: fixtures.length, residue: 0 };
}

async function main(): Promise<void> {
  requireFixtureGuard();
  const [action, countValue] = process.argv.slice(2);
  const started = performance.now();
  let result: Record<string, unknown>;
  switch (action) {
    case 'create':
      result = await createTo(parseCount(countValue));
      break;
    case 'concurrent':
      result = await createConcurrent(parseCount(countValue, 64));
      break;
    case 'verify':
      result = await verifyFixtureSet(countValue === undefined ? undefined : parseCount(countValue));
      break;
    case 'reuse':
      result = await proveLowestReuse();
      break;
    case 'delete':
      result = await deleteAllFixtures();
      break;
    default:
      throw new Error('Usage: app-network-scale.ts create|verify|concurrent [count] | reuse | delete');
  }
  process.stdout.write(`${JSON.stringify({
    action,
    durationMs: Math.round(performance.now() - started),
    ...result,
  })}\n`);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown live scale harness failure';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
