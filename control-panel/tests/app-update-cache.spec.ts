/**
 * Plan 11 F3 and F2's timers: the UI and Pointer update check starts from instrumentation.ts (never on import), the
 * OCI digest check that covered no app is gone, and the 3-hour and 6-hour checks wait 0–10 % longer at random.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test, { mock } from 'node:test';
import { load, root } from './fixtures/market-world';

const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const HOURS = 60 * 60 * 1000;

function updateCache(checks: { count: number }) {
  return load('src/lib/apps/update-cache.ts', {
    './lxd-updates': { checkAllLxdUpdates: async () => { checks.count++; return new Map(); }, clearLxdUpdateCache: () => {} },
    '@/lib/infrastructure/deployer': { isDeploymentInProgress: () => false },
    '@/lib/releases/installed-release': { publishUIRelease: async () => {} },
  });
}

test('withJitter adds 0–10 % to an interval', () => {
  const { withJitter } = updateCache({ count: 0 });
  assert.equal(withJitter(3 * HOURS, 0), 3 * HOURS);
  assert.equal(withJitter(3 * HOURS, 0.5), 3.15 * HOURS);
  assert.ok(withJitter(3 * HOURS, 0.999999) <= 3.3 * HOURS);
  assert.equal(withJitter(6 * HOURS, 2), 6.6 * HOURS, 'clamped');
  assert.equal(withJitter(6 * HOURS, -1), 6 * HOURS, 'clamped');
  assert.equal(withJitter(6 * HOURS, Number.NaN), 6 * HOURS);
  for (let n = 0; n < 200; n++) {
    const delay = withJitter(6 * HOURS);
    assert.ok(delay >= 6 * HOURS && delay <= 6.6 * HOURS, String(delay));
  }
});

test('the update check does not start on import; started, it runs after 30 s and then every 3 h plus jitter', async (t) => {
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());
  const random = mock.method(Math, 'random', () => 0.5);
  t.after(() => random.mock.restore());
  const checks = { count: 0 };
  const cache = updateCache(checks);
  mock.timers.tick(10 * HOURS);
  assert.equal(checks.count, 0, 'importing the module starts nothing');

  cache.startBackgroundChecks();
  cache.startBackgroundChecks();
  mock.timers.tick(29_999);
  assert.equal(checks.count, 0);
  mock.timers.tick(1);
  assert.equal(checks.count, 1, 'once, even when started twice');
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.ok(cache.getLastCheckedAt());
  mock.timers.tick(3.15 * HOURS - 1);
  assert.equal(checks.count, 1, 'not before 3 h + jitter');
  mock.timers.tick(1);
  assert.equal(checks.count, 2);
  cache.stopBackgroundChecks();
  for (let i = 0; i < 5; i++) await Promise.resolve();
  mock.timers.tick(10 * HOURS);
  assert.equal(checks.count, 2, 'stopped');
});

test('instrumentation starts the update check after the identity-service gate; no module starts itself', () => {
  const instrumentation = read('src/instrumentation.ts');
  const gate = instrumentation.indexOf('IDENTITY_SERVICE === "true"');
  const start = instrumentation.indexOf('startBackgroundChecks()');
  assert.ok(gate > 0 && start > gate, 'started only in the Control Panel, never in youeye-id.service');
  assert.match(instrumentation, /await import\("@\/lib\/apps\/update-cache"\)/);
  const cache = read('src/lib/apps/update-cache.ts');
  assert.doesNotMatch(cache, /^\s*startBackgroundChecks\(\);/m);
  assert.doesNotMatch(cache, /NODE_ENV !== 'test'/);
  assert.doesNotMatch(cache, /setInterval/);
  const versionChecker = read('src/lib/market/version-checker.ts');
  assert.match(versionChecker, /withJitter\(CHECK_INTERVAL_MS\)/);
  assert.doesNotMatch(versionChecker, /setInterval/);
});

test('the OCI digest check is gone; the UI and Pointer checks stay', () => {
  const cache = read('src/lib/apps/update-cache.ts');
  assert.match(cache, /checkAllLxdUpdates\(\)/);
  assert.doesNotMatch(cache, /checkAllUpdates|refreshAppUpdate|getAllCachedUpdates|clearBaselineDigest/);
  const registry = read('src/lib/apps/registry.ts');
  assert.match(registry, /export function containerStatusToAppStatus/);
  assert.doesNotMatch(registry, /digest|spineClient/i);
  assert.doesNotMatch(read('src/lib/spine/client.ts'), /getRegistryDigest|\/api\/registry\/digest/);
  for (const route of ['src/app/api/apps/unified/route.ts', 'src/app/api/ui-bridge/apps/route.ts']) {
    assert.doesNotMatch(read(route), /getAllCachedUpdates|ociUpdates/, route);
  }
  // It covered nothing: no built-in app definition names an image to watch.
  const definitions = read('src/lib/apps/definitions.ts');
  const builtIn = definitions.slice(definitions.indexOf('export const APP_DEFINITIONS'), definitions.indexOf('\n];', definitions.indexOf('export const APP_DEFINITIONS')));
  assert.doesNotMatch(builtIn, /imageRef:/);
});

/** lxd-updates.ts over fakes: the UI is a member of the System release `version`. */
function lxdUpdates(version: { value: string }) {
  return load('src/lib/apps/lxd-updates.ts', {
    '@/lib/version': { compareReleases: () => 0, releaseKey: () => ({ line: '0.6.11', sequence: 1 }) },
    '@/lib/releases/channel-index': { describeReleaseError: (error: unknown) => String(error), readChannelIndex: async () => ({ index: { products: {} } }) },
    '@/lib/releases/core-release': { loadSelectedCore: () => ({ version: version.value }) },
    '@/lib/updates/provenance': { getCoreProvenance: async () => null },
    './definitions': { APP_DEFINITIONS: [{ id: 'ui', lxdConfig: {}, containers: ['ui'] }] },
  });
}

test('the check that instrumentation runs is what the API routes read: every copy of the modules shares it', async (t) => {
  // Next bundles instrumentation and each API route separately: each gets its own copy of these modules.
  const keys = [Symbol.for('youeye.lxd-update-cache'), Symbol.for('youeye.app-update-checker')];
  const clear = () => { for (const key of keys) delete (globalThis as Record<symbol, unknown>)[key]; };
  clear();
  t.after(clear);
  const version = { value: '0.6.11-beta.1' };
  const instrumentationCopy = lxdUpdates(version);
  const routeCopy = lxdUpdates(version);
  assert.equal(routeCopy.getAllCachedLxdUpdates().size, 0);
  await instrumentationCopy.checkAllLxdUpdates();
  assert.equal(routeCopy.getAllCachedLxdUpdates().get('ui')?.installedVersion, '0.6.11-beta.1', 'the route sees the result');
  assert.equal(routeCopy.getCachedLxdUpdate('ui')?.installedVersion, '0.6.11-beta.1');
  routeCopy.clearLxdUpdateCache('ui');
  assert.equal(instrumentationCopy.getCachedLxdUpdate('ui'), null, 'and a clear from an update route reaches the checker');

  // The checker's own state (last check, in progress) too.
  let finish!: () => void;
  const running = new Promise<void>((resolve) => { finish = resolve; });
  const runs = { count: 0 };
  const updateCacheCopy = () => load('src/lib/apps/update-cache.ts', {
    './lxd-updates': { checkAllLxdUpdates: async () => { runs.count++; await running; return instrumentationCopy.checkAllLxdUpdates(); }, clearLxdUpdateCache: () => {} },
    '@/lib/infrastructure/deployer': { isDeploymentInProgress: () => false },
    '@/lib/releases/installed-release': { publishUIRelease: async () => {} },
  });
  const checker = updateCacheCopy();
  const route = updateCacheCopy();
  assert.equal(route.getLastCheckedAt(), null);
  const check = checker.refreshAllUpdates();
  assert.equal(route.isCheckInProgress(), true);
  await route.refreshAllUpdates();
  assert.equal(runs.count, 1, 'a check already running in another copy is not started again');
  finish();
  await check;
  assert.equal(route.isCheckInProgress(), false);
  assert.ok(route.getLastCheckedAt());
  assert.equal(routeCopy.getCachedLxdUpdate('ui')?.installedVersion, '0.6.11-beta.1');
  // One timer for the process, whichever copy starts or stops it.
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());
  checker.startBackgroundChecks();
  route.startBackgroundChecks();
  route.stopBackgroundChecks();
  mock.timers.tick(10 * HOURS);
  assert.equal(runs.count, 1, 'started once, stopped from the other copy: no check ran');
});

test('the Market version check is shared by every copy of its module: in progress, last checked and results', async (t) => {
  const key = Symbol.for('youeye.market-version-checker');
  const clear = () => { delete (globalThis as Record<symbol, unknown>)[key]; };
  clear();
  t.after(clear);
  let finish!: () => void;
  const running = new Promise<void>((resolve) => { finish = resolve; });
  const runs = { count: 0 };
  const found = [{ id: 'alpha', updateAvailable: true }];
  const versionCheckerCopy = () => load('src/lib/market/version-checker.ts', {
    './installed-apps': { checkForUpdates: async () => { runs.count++; await running; return found; }, migrateFromInstallJson: async () => {} },
    './catalog': { clearCatalogCache: () => {} },
    '@/lib/apps/update-cache': { refreshAllUpdates: async () => {}, withJitter: (ms: number) => ms },
    '@/lib/infrastructure/deployer': { isDeploymentInProgress: () => false },
  });
  // instrumentation's copy runs the check; an API route's copy reads it.
  const checker = versionCheckerCopy();
  const route = versionCheckerCopy();
  assert.equal(route.getLastVersionCheckAt(), null);
  assert.deepEqual(route.getLastVersionCheckResults(), []);
  const check = checker.refreshVersionCheck();
  assert.equal(route.isVersionCheckInProgress(), true);
  await route.refreshVersionCheck();
  assert.equal(runs.count, 1, 'a check already running in another copy is not started again');
  finish();
  await check;
  assert.equal(route.isVersionCheckInProgress(), false);
  assert.ok(route.getLastVersionCheckAt());
  assert.deepEqual(route.getLastVersionCheckResults(), found);
  // One timer for the process, whichever copy starts or stops it.
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());
  checker.startVersionChecker();
  route.startVersionChecker();
  route.stopVersionChecker();
  mock.timers.tick(10 * HOURS);
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(runs.count, 2, 'only the first copy\'s start-up check ran: started once, stopped from the other copy');
});
