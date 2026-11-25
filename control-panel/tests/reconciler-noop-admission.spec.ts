import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

function fixture() {
  const metadata = Array.from({ length: 17 }, (_, i) => ({ appId: `example${i}`, lifecycleState: 'active', subdomain: `example${i}`, domain: 'fixture.test', containers: [{ name: 'main', containerName: `app-example${i}`, type: 'oci' }] }));
  const registrations = new Map(metadata.map(m => [m.appId, { unchanged: true }]));
  const operations = new Map<string, unknown>();
  const admitted: string[] = []; const writes: string[] = []; const visible: string[] = []; const resolved: string[] = [];
  const damaged: string[] = []; let locked = false; let denied = false; let audited = true; let drift = false;
  class AdmissionError extends Error {}
  class UIProjectionDriftError extends Error {}
  const warnings: string[] = []; let auditFailure: Error | null = null; const corrupt = new Set<string>();
  const mocks: Record<string, any> = {
    'fs/promises': { readFile: async () => 'fixture-token' },
    './installed-apps': { getAllInstalledApps: async () => metadata.map(m => ({ appId: m.appId })), upsertInstalledApp: async () => { assert.ok(locked); writes.push('install'); } },
    './metadata': { listInstalledApps: async () => metadata, scanInstalledApps: async () => ({ apps: metadata, damaged }), readInstallMetadata: async (id: string) => metadata.find(m => m.appId === id) },
    '@/lib/reconfigure/journal': { readReconfigureJournal: async () => null },
    '@/lib/health/issues': { resolveIssue: async (id: string) => { resolved.push(id); }, observeIssue: async () => {}, recordTimelineEvent: async () => {} },
    '@/lib/caddy/client': { getRoutes: async () => metadata.map(m => ({ hostname: `${m.subdomain}.${m.domain}`, upstream: `app-${m.appId}` })) },
    './install-tracker': {
      recoverInterruptedInstalls: () => [], pruneCompletedInstallOperations: () => {}, getAllActiveInstalls: () => [],
      describeErrorChainForLog: function chain(error: any): string { return `${error.message}${error.cause ? ` <cause> ${chain(error.cause)}` : ''}`; },
      getTrackedInstall: (id: string) => {
        if (corrupt.has(id)) throw new Error(`Durable install operation for ${id} is corrupt or insecure`);
        return operations.get(id);
      },
      reconcileCompletedInstallOperation: (id: string) => { assert.ok(locked); if (!operations.has(id)) return false; writes.push(`operation:${id}`); operations.delete(id); return true; },
    },
    './update-admission': { AppLifecycleAdmissionError: AdmissionError, withAppLifecycle: async (id: string, work: () => Promise<void>) => {
      admitted.push(id); if (denied) throw new AdmissionError(); locked = true; try { return await work(); } finally { locked = false; }
    } },
    '@/lib/incus/app-network': {
      reconcileAppNetworks: async () => ({ repaired: [], unresolved: [], observedNetworks: audited ? metadata.map(m => ({ appId: m.appId, state: 'active' })) : undefined }),
      listAppNetworks: async () => metadata.map(m => ({ appId: m.appId, state: 'active' })),
      hasActiveAppNetwork: async (id: string) => { assert.ok(locked); visible.push(id); return true; },
    },
    '@/lib/incus/server': {
      incusRequest: async () => ({ metadata: metadata.flatMap(m => m.containers.map(name => ({ name }))) }),
      execCommand: async () => ({ exitCode: 0, stdout: JSON.stringify([...registrations].map(([id, connections]) => ({ id, connections }))) }),
    },
    '../bridges/manager': { UIProjectionDriftError, refreshConnectionGrants: async () => [], startRewirePass: async () => [], pushConnectionsToUI: async (id: string, options: any) => {
      if (auditFailure && id === 'example0' && options.auditOnly) throw auditFailure;
      if (drift && id === 'example0') {
        if (options.auditOnly) throw new UIProjectionDriftError('projection requires repair');
        assert.ok(locked); writes.push(`projection:${id}`); drift = false;
      }
    } },
  };
  const exports: Record<string, any> = {};
  vm.runInNewContext(ts.transpileModule(readFileSync('src/lib/market/reconciler.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, {
    exports, console: { ...console, warn: (line: string) => warnings.push(line) }, process: { env: {} }, require: (name: string) => mocks[name] ?? {},
  });
  return {
    reconcile: exports.reconcileApps, damaged, resolved, admitted, writes, visible, operations, warnings,
    drift() { drift = true; }, deny() { denied = true; }, invalidate() { audited = false; },
    failAudit(error: Error) { auditFailure = error; }, corrupt,
  };
}

test('17 unchanged registrations do not acquire mutation locks or repeat bridge reads', async () => {
  const f = fixture(); const result = await f.reconcile();
  assert.equal(result.unresolved.length, 0);
  assert.ok(f.resolved.includes('market.reconcile.divergence'));
  assert.deepEqual(f.admitted, []); assert.deepEqual(f.visible, []); assert.deepEqual(f.writes, []);
});

test('projection drift is repaired only after fresh lifecycle admission and visibility checks', async () => {
  const f = fixture(); f.drift(); const result = await f.reconcile();
  assert.equal(result.unresolved.length, 0);
  assert.deepEqual(f.admitted, ['example0']); assert.deepEqual(f.visible, ['example0']);
  assert.deepEqual(f.writes, ['projection:example0']);
  f.admitted.length = 0; await f.reconcile(); assert.deepEqual(f.admitted, []);
});

test('projection drift is repaired quietly; any other audit failure is logged with its cause and repaired', async () => {
  const f = fixture(); f.drift(); await f.reconcile();
  assert.deepEqual(f.warnings, []);
  const g = fixture();
  g.failAudit(new Error('Current UI connection projection could not be verified', { cause: new Error('caddy root.crt unreadable') }));
  const result = await g.reconcile();
  assert.deepEqual(g.admitted, ['example0'], 'a failed audit still falls back to the admitted repair');
  assert.equal(result.unresolved.length, 0);
  assert.equal(g.warnings.length, 1);
  assert.match(g.warnings[0], /ui-drawer:example0 audit failed, repairing: .*could not be verified <cause> caddy root\.crt unreadable/);
});

test('an unreadable install operation record sends that app to admission and the pass goes on', async () => {
  const f = fixture(); f.corrupt.add('example0');
  const result = await f.reconcile();
  assert.deepEqual(f.admitted, ['example0']);
  assert.equal(result.unresolved.length, 0);
  assert.deepEqual(f.warnings, [], 'the record is reported by the admitted repair, not as an audit failure');
});

test('reserved projection drift cannot publish and unfinished operations cannot skip admission', async () => {
  const f = fixture(); f.drift(); f.deny(); const result = await f.reconcile();
  assert.deepEqual(f.admitted, ['example0']); assert.deepEqual(f.writes, []);
  // The busy app was not checked: recorded as skipped, and "App state is out of sync" is not resolved.
  assert.deepEqual([...result.skipped], ['example0']);
  assert.ok(!f.resolved.includes('market.reconcile.divergence'));
  const operation = fixture(); operation.operations.set('example0', { done: true, error: 'interrupted finalization' });
  await operation.reconcile(); assert.deepEqual(operation.admitted, ['example0']);
  assert.deepEqual(operation.writes, ['operation:example0']);
});

test('a changed network audit forces fresh under-lock visibility checks for every registration', async () => {
  const f = fixture(); f.invalidate(); const result = await f.reconcile();
  assert.equal(result.unresolved.length, 0); assert.equal(f.admitted.length, 17); assert.equal(f.visible.length, 17);
});

test('a damaged install record is reported by app and keeps the divergence issue open', async () => {
  const f = fixture(); f.damaged.push('broken');
  const result = await f.reconcile();
  assert.deepEqual([...result.unresolved], ['install-record:broken']);
  assert.ok(!f.resolved.includes('market.reconcile.divergence'));
});
