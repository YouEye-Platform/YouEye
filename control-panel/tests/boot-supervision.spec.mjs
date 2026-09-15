import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

// Source-regression checks for CP boot supervision.
// Run: CONTROL_PANEL_ROOT="$PWD" pnpm exec node --test tests/boot-supervision.spec.mjs
const repoRoot = process.env.CONTROL_PANEL_ROOT || join(import.meta.dirname, '..');
const read = (p) => readFileSync(join(repoRoot, p), 'utf8');

test('Next instrumentation starts the health monitor on CP server startup', () => {
  const instrumentation = read('src/instrumentation.ts');
  assert.match(instrumentation, /@\/lib\/health\/monitor/);
  assert.match(instrumentation, /startHealthMonitor\(\)/);
  assert.match(instrumentation, /NEXT_PHASE === "phase-production-build"/);
});

test('LXD-created CP-owned containers carry explicit Incus boot autostart', () => {
  const deployer = read('src/lib/infrastructure/lxd-deployer.ts');
  assert.match(deployer, /'boot\.autostart': 'true'/);
  assert.match(deployer, /'security\.privileged': 'false'/);
});

test('watchdog keeps Pi-hole and Control Panel outside CP restart ownership', () => {
  const monitor = read('src/lib/health/monitor.ts');
  assert.match(monitor, /WATCHDOG_EXCLUDE = new Set\(\['youeye-pihole', 'youeye-control'\]\)/);
  assert.match(monitor, /cfg\['boot\.autostart'\] \?\? 'true'/);
  assert.match(monitor, /inspectAppStorage\(app\.storageVolumes\)/);
  assert.match(monitor, /recoverySuppressed\.has\(name\)/);
  assert.doesNotMatch(monitor, /Auto-start when module is imported/);
});

test('health route no longer owns monitor startup by import side effect', () => {
  const route = read('src/app/api/health/services/route.ts');
  assert.doesNotMatch(route, /@\/lib\/health\/monitor/);
});

test('identity service mode skips platform background jobs', () => {
  const instrumentation = read('src/instrumentation.ts');
  // The gate must exist and must sit BEFORE every platform job start.
  const gate = instrumentation.indexOf('IDENTITY_SERVICE === "true"');
  assert.ok(gate >= 0, 'instrumentation must check IDENTITY_SERVICE');
  for (const job of [
    'startHealthMonitor()',
    'startDnsProviderMaintenanceLoop()',
    'startWorker()',
    'startVersionChecker()',
    'startHealthChecker()',
  ]) {
    const at = instrumentation.indexOf(job);
    assert.ok(at >= 0, `instrumentation must start ${job}`);
    assert.ok(gate < at, `${job} must come after the identity-service gate`);
  }
});

test('update queue worker starts only from instrumentation, not module import', () => {
  const queue = read('src/lib/updates/queue.ts');
  assert.match(queue, /export function startWorker/);
  assert.doesNotMatch(queue, /\/\/ Auto-start in production/);
  assert.doesNotMatch(queue, /NODE_ENV !== 'test'/);
  const instrumentation = read('src/instrumentation.ts');
  assert.match(instrumentation, /@\/lib\/updates\/queue/);
});

test('version-checker and health-checker start only from instrumentation, not module import', () => {
  // The 0.5.4 gate missed these two: their import side effects started a
  // second checker inside youeye-id.service, and the pair raced the
  // installed-apps.json atomic rename (ENOENT on .tmp, devvm1 2026-07-02).
  for (const file of ['src/lib/market/version-checker.ts', 'src/lib/market/health-checker.ts']) {
    const src = read(file);
    assert.doesNotMatch(src, /\/\/ Auto-start when module is imported/, `${file} must not auto-start on import`);
    assert.doesNotMatch(src, /NODE_ENV !== 'test'/, `${file} must not gate an import side effect on NODE_ENV`);
  }
  const instrumentation = read('src/instrumentation.ts');
  assert.match(instrumentation, /@\/lib\/market\/version-checker/);
  assert.match(instrumentation, /@\/lib\/market\/health-checker/);
});

test('market install resolves subdomain and source server-side for thin clients', () => {
  const route = read('src/app/api/market/install/route.ts');
  // appId is the only hard-required field (CLI sends {appId} alone).
  assert.doesNotMatch(route, /Missing required fields: appId, subdomain/);
  assert.match(route, /manifest\.metadata\?\.defaultSubdomain \|\| config\.appId/);
  assert.match(route, /getMarketSource\(\)/);
});

test('install persists catalogVersion at install time (no null baseline)', () => {
  const engine = read('src/lib/market/engine.ts');
  assert.match(engine, /catalogVersion: installedVersion \|\| undefined/);
  assert.match(engine, /catalogVersion: finalMetadata\.catalogVersion \?\? null/);
  const store = read('src/lib/market/installed-apps.ts');
  assert.match(store, /catalogVersion: data\.catalogVersion \?\? null/);
});
