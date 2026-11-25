/**
 * YE-222: a removal that did not finish must be finishable, and never end in a reinstall on the old data.
 * - `--force` without an install record rebuilds the recovery map from what carries the app's tags in Incus;
 * - the background network pass leaves a user's unfinished removal to the user (it would keep the data);
 * - a fresh install refuses over an earlier installation's volumes.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { nextRemovalStage, removalModeOf, removalStage } from '../src/lib/incus/app-network';

const root = process.env.CONTROL_PANEL_ROOT || path.join(import.meta.dirname, '..');
const OLD = '20000000-0000-4000-8000-000000000001';
const OTHER = '20000000-0000-4000-8000-000000000002';

function load(file: string, mocks: Record<string, unknown>) {
  const exports: Record<string, any> = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(path.join(root, 'src', file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText, { exports, module: { exports }, console, URL, setTimeout, require: (name: string) => {
    if (name in mocks) return mocks[name];
    return new Proxy({}, { get: (_t, property) => property === '__esModule' ? true
      : () => { throw new Error(`Unexpected effect: ${name}.${String(property)}`); } });
  } });
  return exports;
}

const volume = (name: string, config: Record<string, string>, usedBy: string[] = []) =>
  ({ name, type: 'custom', content_type: 'filesystem', config, used_by: usedBy });
const appVolume = (app: string, logical: string, installation = OLD) => volume(`ye-${app}-main-${logical}`, {
  'user.youeye.kind': 'app', 'user.youeye.app_id': app, 'user.youeye.logical_name': logical,
  'user.youeye.volume_type': 'config', 'user.youeye.installation_id': installation, 'user.youeye.data_owner_id': 'owner-1',
});

function storageIncus(volumes: unknown[]) {
  return async (_method: string, route: string) => {
    if (route === '/1.0/storage-pools?recursion=1') return { type: 'sync', metadata: [{ name: 'default', status: 'Created', driver: 'zfs' }] };
    if (route.endsWith('/resources')) return { type: 'sync', metadata: { space: { total: 10, used: 1 } } };
    if (route === '/1.0/storage-pools/default/volumes/custom?recursion=1') return { type: 'sync', metadata: volumes };
    throw new Error(`unexpected ${route}`);
  };
}

test('an app\'s own volumes are found by their tags, never a shared one or another app\'s (YE-222)', async () => {
  const storage = load('lib/market/storage.ts', {
    '../incus/server': { incusRequest: storageIncus([
      appVolume('sonarr', 'config'), appVolume('sonarr', 'custom-cont-init-d'),
      appVolume('sonarr-two', 'config'),
      volume('ye-shared-media', { 'user.youeye.kind': 'shared', 'user.youeye.app_id': '', 'user.youeye.storage_group': 'media' }),
    ]) },
  });
  const found = JSON.parse(JSON.stringify(await storage.findAppOwnedVolumes('sonarr')));
  assert.deepEqual(found.map((v: any) => v.name), ['ye-sonarr-main-config', 'ye-sonarr-main-custom-cont-init-d']);
  assert.deepEqual([found[0].pool, found[0].installationId, found[0].dataOwnerId, found[0].logicalName, found[0].type],
    ['default', OLD, 'owner-1', 'config', 'config']);
});

function reconciler(instances: unknown[], volumes: unknown[], state: {
  retained?: unknown; retainedThrows?: boolean; policy?: unknown; policyThrows?: boolean; listed?: boolean; record?: unknown;
  modes?: string[]; copyVerified?: boolean;
} = {}) {
  return load('lib/market/reconciler.ts', {
    './metadata': {
      readInstallMetadata: async () => state.record ?? null,
      readRetainedInstallMetadata: async () => { if (state.retainedThrows) throw new Error('unsafe'); return state.retained ?? null; },
    },
    '@/lib/admission/store': { getAdmissionPolicy: async () => { if (state.policyThrows) throw new Error('db down'); return state.policy ?? null; } },
    './installed-apps': { getInstalledApp: async () => (state.listed ? { appId: 'sonarr' } : null) },
    './update-admission': { withAppLifecycle: async (_id: string, work: () => unknown) => work() },
    '@/lib/incus/server': { incusRequest: async (_m: string, route: string) => {
      if (route === '/1.0/instances?recursion=1') return { type: 'sync', metadata: instances };
      if (route === '/1.0/instances') return { type: 'sync', metadata: instances.map((i: any) => `/1.0/instances/${i.name}`) };
      throw new Error(`unexpected ${route}`);
    } },
    '@/lib/incus/app-network': {
      recordRemovalMode: async (_id: string, keep: boolean) => { (state.modes ??= []).push(keep ? 'keep' : 'delete'); },
      withRemovalRequest: async (_id: string, work: () => unknown) => work(),
    },
    '@/lib/admission/retained-data': {
      verifyPreviouslyRetainedRoot: async () => { if (!state.copyVerified) throw new Error('Missing retained root recovery map'); },
      cleanupAdoptedRetainedCopies: async () => false,
    },
    './storage': { findAppOwnedVolumes: async () => volumes, deleteAppStorage: async () => {} },
    './instance-ownership': { APP_TAG: 'user.youeye.app_id', INSTALLATION_TAG: 'user.youeye.installation_id' },
    './install-tracker': { describeErrorChainForLog: (error: unknown) => String(error) },
  });
}

test('--force without an install record rebuilds the map from the app\'s tagged leftovers (YE-222)', async () => {
  const tagged = (name: string, app: string, installation: string) =>
    ({ name, config: { 'user.youeye.app_id': app, 'user.youeye.installation_id': installation } });
  const volumes = [{ appId: 'sonarr', name: 'ye-sonarr-main-config', installationId: OLD, pool: 'default' }];
  // The half-removed copy: no instance left (Incus deleted it later), its two volumes stay.
  let map = JSON.parse(JSON.stringify(await reconciler([tagged('app-radarr', 'radarr', OTHER)], volumes).leftoverRecoveryMap('sonarr')));
  assert.equal(map.metadata.installationId, OLD);
  assert.deepEqual(map.metadata.containers, []);
  assert.deepEqual(map.metadata.storageVolumes.map((v: any) => v.name), ['ye-sonarr-main-config']);
  // An instance still tagged with it is part of the map (deleted first, by its installation tag).
  map = JSON.parse(JSON.stringify(await reconciler([tagged('app-sonarr', 'sonarr', OLD)], volumes).leftoverRecoveryMap('sonarr')));
  assert.deepEqual(map.metadata.containers.map((c: any) => c.containerName), ['app-sonarr']);
  // Leftovers of two installations: refused, nothing removed.
  map = await reconciler([tagged('app-sonarr', 'sonarr', OTHER)], volumes).leftoverRecoveryMap('sonarr');
  assert.match(map.refused, /different installations; nothing was removed/);
});

test('the forced cleanup uses the rebuilt map only with --force; the network pass leaves a user\'s removal (YE-222)', () => {
  const reconcilerSource = readFileSync(path.join(root, 'src/lib/market/reconciler.ts'), 'utf8');
  assert.match(reconcilerSource, /if \(!recoveryMetadata\) \{\s*if \(!options\.force\) \{\s*return \{ repaired: \[\], unresolved: \[`ownership:\$\{appId\}:install metadata is required before cleanup`\] \};\s*\}[\s\S]{0,600}const refusal = await forceWithoutRecordRefusal\(appId\);\s*if \(refusal\) return[^\n]*\n\s*const rebuilt = await leftoverRecoveryMap\(appId\);/);
  const network = readFileSync(path.join(root, 'src/lib/incus/app-network.ts'), 'utf8');
  const skip = network.indexOf("if (pending?.cleanupPending && pending.lifecycleState !== 'installing') {");
  const finish = network.indexOf("const cleanup = await cleanupAppByScan(originalLease.appId, { keepData });");
  assert.ok(skip > 0 && skip < finish, 'checked before the keep-data finish');
});

test('a fresh install refuses over an earlier installation\'s volumes, and names how to finish (YE-222)', () => {
  const engine = readFileSync(path.join(root, 'src/lib/market/engine.ts'), 'utf8');
  const preflight = engine.slice(engine.indexOf('if (!restoreOptions) {'), engine.indexOf('const database = manifest.database;'));
  assert.match(preflight, /listRetainedApps\(\)\)\.some\(\(retained\) => retained\.appId === appId\)/, 'retained data keeps its adoption path');
  assert.match(preflight, /const leftovers = await findAppOwnedVolumes\(appId\);\s*if \(leftovers\.length\) \{\s*throw new AppNetworkOperationConflictError/);
  assert.match(preflight, /youeye app remove \$\{appId\} --force \(deletes it\)/);
  assert.match(engine, /if \(durable\?\.cleanupPending\) \{[\s\S]{0,400}throw new AppNetworkOperationConflictError\(`The removal of \$\{appId\} did not finish; finish it first: `/);
});

// ─── Iris's review of YE-222 ────────────────────────────────────────────────

test('BLOCKER sequence: an app removed with keep-data, then remove --force: refused, nothing deleted (YE-222 review)', async () => {
  // A keep-data uninstall leaves retained.json (no install.json), its ye-retained-* root copy and its volumes, and a
  // retained admission policy. Every Incus or storage call throws in this harness unless listed, so a refusal that
  // comes back proves nothing was touched.
  const retainedCopy = { name: 'ye-retained-1', config: { 'user.youeye.app_id': 'sonarr', 'user.youeye.installation_id': OLD,
    'user.youeye.retained_source': 'app-sonarr' } };
  const volumes = [{ appId: 'sonarr', name: 'ye-sonarr-main-config', installationId: OLD, pool: 'default' }];
  const r = reconciler([retainedCopy], volumes, { retained: { appId: 'sonarr', containers: [] }, policy: { state: 'retained' } });
  const result = JSON.parse(JSON.stringify(await r.cleanupAppByScan('sonarr', { keepData: false, force: true })));
  assert.deepEqual(result.repaired, []);
  assert.match(result.unresolved.join(' '), /its data is kept \(a removal with keep-data started or finished\), and kept data is never deleted this way/);
  // A delete-data cleanup without --force is refused on the kept data too (the shared check), and a keep-data one
  // without a record refuses as before.
  const plain = JSON.parse(JSON.stringify(await r.cleanupAppByScan('sonarr', { keepData: false })));
  assert.match(plain.unresolved.join(' '), /its data is kept/);
  const keep = JSON.parse(JSON.stringify(await r.cleanupAppByScan('sonarr', { keepData: true })));
  assert.match(keep.unresolved.join(' '), /install metadata is required before cleanup/);
});

test('--force without a record refuses for every kind of kept, unreadable or still-listed app (YE-222 review)', async () => {
  const refuse = async (state: Parameters<typeof reconciler>[2]) => reconciler([], [], state).forceWithoutRecordRefusal('sonarr');
  assert.match(await refuse({ retained: { appId: 'sonarr' } }), /data is kept/);
  assert.match(await refuse({ retainedThrows: true }), /kept-data record could not be read; nothing was removed/);
  assert.match(await refuse({ policy: { state: 'retained' } }), /its data is kept .* youeye app remove sonarr --keep-data/);
  assert.match(await refuse({ policy: { state: 'quarantined' } }), /data is quarantined/);
  assert.match(await refuse({ policyThrows: true }), /ownership could not be read; nothing was removed/);
  assert.match(await refuse({ listed: true }), /still listed as installed but has no install record/);
  // A half-removal (no record, no retained data, not listed, policy ready or deleted) may be finished.
  assert.equal(await refuse({ policy: { state: 'ready' } }), null);
  assert.equal(await refuse({ policy: { state: 'deleted' } }), null);
});

test('a retained root copy is never part of a rebuilt map (YE-222 review)', async () => {
  const copy = { name: 'ye-retained-1', config: { 'user.youeye.app_id': 'sonarr', 'user.youeye.installation_id': OLD,
    'user.youeye.retained_source': 'app-sonarr' } };
  const map = JSON.parse(JSON.stringify(await reconciler([copy], []).leftoverRecoveryMap('sonarr')));
  assert.deepEqual(map.metadata.containers, []);
});

test('a removal\'s mode travels on its lease stage; without one the pass finishes nothing (YE-222 review)', () => {
  const network = { removalStage, removalModeOf };
  assert.equal(network.removalStage('uninstall', true), 'uninstall-keep-data');
  assert.equal(network.removalStage('scan-cleanup', false), 'scan-cleanup-delete-data');
  assert.equal(network.removalModeOf('uninstall-keep-data'), 'keep-data');
  assert.equal(network.removalModeOf('uninstall-metadata-delete-data'), 'delete-data');
  for (const old of ['uninstall', 'uninstall-metadata', 'scan-cleanup', 'delete', undefined]) assert.equal(network.removalModeOf(old), null);
  const source = readFileSync(path.join(root, 'src/lib/incus/app-network.ts'), 'utf8');
  assert.match(source, /const mode = removalModeOf\(currentLease\.failure\?\.stage\);\s*if \(!mode\) \{/);
  assert.match(source, /keepData = mode === 'keep-data';[\s\S]{0,400}cleanupAppByScan\(originalLease\.appId, \{ keepData \}\)/);
  const uninstaller = readFileSync(path.join(root, 'src/lib/market/uninstaller.ts'), 'utf8');
  assert.match(uninstaller, /markAppNetworkCleanupPending\(appId, removalStage\('uninstall', keepData\)/);
  assert.match(uninstaller, /markAppNetworkCleanupPending\(appId, removalStage\('uninstall-metadata', keepData\)/);
  const reconcilerSource = readFileSync(path.join(root, 'src/lib/market/reconciler.ts'), 'utf8');
  assert.match(reconcilerSource, /removalStage\('scan-cleanup', options\.keepData !== false\)/);
});

test('the shared database is dropped only once every container is gone (YE-222 review)', () => {
  const uninstaller = readFileSync(path.join(root, 'src/lib/market/uninstaller.ts'), 'utf8');
  assert.match(uninstaller, /if \(dropDb && !containersGone\) \{[\s\S]{0,300}\} else if \(dropDb\) \{\s*try \{\s*await dropSharedPostgresDatabase/);
  const reconcilerSource = readFileSync(path.join(root, 'src/lib/market/reconciler.ts'), 'utf8');
  assert.match(reconcilerSource, /if \(shouldDropDatabase && !instancesGone\) \{[\s\S]{0,160}\} else if \(shouldDropDatabase\) \{/);
});

test('the leftover-volume refusal comes before the older app-directory one, and the hint follows the mode (YE-222 review)', () => {
  const engine = readFileSync(path.join(root, 'src/lib/market/engine.ts'), 'utf8');
  const preflight = engine.slice(engine.indexOf('if (!restoreOptions) {'), engine.indexOf('const database = manifest.database;'));
  assert.ok(preflight.indexOf('findAppOwnedVolumes(appId)') < preflight.indexOf('leftoverAppPaths(appId)'));
  assert.match(engine, /mode === 'keep-data' \? `youeye app remove \$\{appId\} --keep-data`/);
});

// ─── Iris's second review: one refusal on every forced and delete-data path ─

const keptRecord = { appId: 'sonarr', installationId: OLD, cleanupPending: true, containers: [{ name: 'main', containerName: 'app-sonarr' }],
  storageVolumes: [{ appId: 'sonarr', name: 'ye-sonarr-main-config', installationId: OLD, pool: 'default' }] };

test('issue 1: a keep-data removal stopped partway (record still there), then --force: refused, nothing touched', async () => {
  // install.json with cleanupPending, retained.json and a retained policy, as a keep-data removal leaves them when a later
  // step fails (0.6.18-0.6.20-alpha.5 deleted the kept data here). Every Incus and storage call throws in this harness.
  const r = reconciler([], [], { record: keptRecord, retained: { appId: 'sonarr' }, policy: { state: 'retained' } });
  for (const options of [{ keepData: false, force: true }, { keepData: true, force: true }]) {
    const result = JSON.parse(JSON.stringify(await r.cleanupAppByScan('sonarr', options)));
    assert.deepEqual(result.repaired, []);
    assert.match(result.unresolved[0], /its data is kept/);
  }
  // Quarantined data with a record: refused the same way.
  const q = reconciler([], [], { record: keptRecord, policy: { state: 'quarantined' } });
  assert.match(JSON.parse(JSON.stringify(await q.cleanupAppByScan('sonarr', { keepData: false, force: true }))).unresolved[0], /quarantined/);
});

test('order A: a failed delete-data attempt, then a --keep-data retry that stopped early: the pass refuses delete-data (issue 2)', async () => {
  // The lease may still say -delete-data, the policy is now retained: the reconcile pass runs cleanupAppByScan
  // ({ keepData: false }) without --force, and the shared check refuses it.
  const r = reconciler([], [], { record: keptRecord, policy: { state: 'retained' } });
  const result = JSON.parse(JSON.stringify(await r.cleanupAppByScan('sonarr', { keepData: false })));
  assert.deepEqual(result.repaired, []);
  assert.match(result.unresolved[0], /its data is kept/);
  // And the retry itself rewrites the lease's mode at its start (uninstaller: recordRemovalMode before any change).
  const uninstaller = readFileSync(path.join(root, 'src/lib/market/uninstaller.ts'), 'utf8');
  assert.ok(uninstaller.indexOf('await recordRemovalMode(appId, keepData);') < uninstaller.indexOf('const { unwireAppConnections }'));
  // A keep request records again first thing once admitted, before the record is even read (Iris, batch 1).
  const steps = uninstaller.slice(uninstaller.indexOf('async function uninstallAppSteps('));
  assert.ok(steps.indexOf('if (keepData && !options.preserveAdmission) await recordRemovalMode(appId, true);') > 0);
  assert.ok(steps.indexOf('if (keepData && !options.preserveAdmission) await recordRemovalMode(appId, true);') < steps.indexOf('if (metadata) {'));
  assert.match(uninstaller, /if \(!keepData \|\| options\.preserveAdmission\) await recordRemovalMode\(appId, keepData\);/);
  // Before the other refusal checks too: a keep-data retry refused there (its containers gone, seen live) still records
  // its mode; only the kept-data refusal of a delete-data request comes first, so that one changes nothing.
  const start = uninstaller.indexOf('if (metadata) {');
  const kept = uninstaller.indexOf('const kept = await keptDataRefusal(appId);', start);
  const mode = uninstaller.indexOf('await recordRemovalMode(appId, keepData);', start);
  const verify = uninstaller.indexOf('await verifyAdmissionCleanup(metadata, keepData', start);
  assert.ok(kept < mode && mode < verify, 'kept-data refusal, then the mode, then the other checks');
  const network = readFileSync(path.join(root, 'src/lib/incus/app-network.ts'), 'utf8');
  assert.match(network, /if \(!lease \|\| lease\.state !== 'cleanup_pending' \|\| lease\.failure\?\.stage === stage\) return;\s*await mutateIpamState[\s\S]{0,400}transitionLease\(current, appId, 'cleanup_pending'/);
});

test('the shared check runs first on every forced or delete-data scan cleanup, not on keep-data ones', () => {
  const source = readFileSync(path.join(root, 'src/lib/market/reconciler.ts'), 'utf8');
  const scan = source.slice(source.indexOf('async function cleanupAppByScanUnderLifecycle('));
  assert.match(scan, /if \(options\.force === true \|\| options\.keepData === false\) \{\s*const kept = await keptDataRefusal\(appId\);\s*if \(kept\) return/);
  assert.ok(scan.indexOf('keptDataRefusal(appId)') < scan.indexOf('readInstallMetadata(appId)'), 'before the record is even read');
  assert.match(source, /export async function forceWithoutRecordRefusal[\s\S]{0,200}const kept = await keptDataRefusal\(appId\);/);
});

test('issue 3: the scan cleanup keeps the secrets while an instance remains, also with no own volumes', () => {
  const source = readFileSync(path.join(root, 'src/lib/market/reconciler.ts'), 'utf8');
  assert.match(source, /if \(!instancesGone\) throw new Error\('its data is kept until its instances are gone'\);\s*if \(own\.length\) await deleteAppStorage\(own\);/);
  assert.ok(source.indexOf("await deleteAllAppSecrets(appId);\n        repaired.push(`secrets:") > source.indexOf('if (!instancesGone) throw new Error'));
});

test('a failed network delete puts the requested mode back on the lease (YE-222, seen live)', () => {
  // deleteAppNetwork marks the lease pending under its own stage ("delete") when the bridge cannot go; without this
  // the removal's mode was lost there (safe: an unknown mode is left to the user, but the hint and the Fix lose it).
  const uninstaller = readFileSync(path.join(root, 'src/lib/market/uninstaller.ts'), 'utf8');
  assert.match(uninstaller, /await deleteAppNetwork\(appId\);\s*\} catch \(error\) \{[^}]*markAppNetworkCleanupPending\(appId, removalStage\('uninstall', keepData\), error\)/);
  const reconcilerSource = readFileSync(path.join(root, 'src/lib/market/reconciler.ts'), 'utf8');
  assert.match(reconcilerSource, /await deleteAppNetwork\(appId\);\s*repaired\.push\(`network:\$\{appId\}`\);\s*\} catch \(error\) \{[\s\S]{0,400}markAppNetworkCleanupPending\(appId, removalStage\('scan-cleanup', options\.keepData !== false\)/);
});

// ─── Iris's third review ────────────────────────────────────────────────────

test('issue 1: a keep-data removal deletes an instance only with its verified retained copy', async () => {
  // retainAppRoots failed: policy retained, retained.json `preparing`, no ye-retained copy. Verification throws: kept.
  const r = reconciler([], [], { copyVerified: false });
  assert.match(await r.retainedCopyRefusal(keptRecord, 'app-sonarr'),
    /^instance:app-sonarr:kept: its retained copy is not verified \(.*Missing retained root recovery map/);
  assert.equal(await reconciler([], [], { copyVerified: true }).retainedCopyRefusal(keptRecord, 'app-sonarr'), null);
  // In the scan: checked right before each delete, only for a keep-data removal of an installed app.
  const source = readFileSync(path.join(root, 'src/lib/market/reconciler.ts'), 'utf8');
  assert.match(source, /const keepDataRemoval = options\.keepData !== false && !interruptedInstall;\s*for \(const name of matchingInstances\) \{\s*if \(keepDataRemoval\) \{\s*const refusal = await retainedCopyRefusal\(recoveryMetadata, name\);\s*if \(refusal\) \{\s*instancesGone = false;\s*unresolved\.push\(refusal\);\s*continue;\s*\}\s*\}\s*try \{\s*await deleteOwnedInstance\(name, owner\);/);
});

test('issue 2: --force records its mode first and decides applicability under the lock', async () => {
  // A failed delete-data attempt left the lease -delete-data; `--force --keep-data` on an intact-looking app is
  // refused here, but its mode is recorded before the refusal (and before anything else could throw).
  const intact = { appId: 'sonarr', installationId: OLD, containers: [{ name: 'main', containerName: 'app-sonarr' }] };
  const state: Parameters<typeof reconciler>[2] = { record: intact, policy: { state: 'ready' } };
  const r = reconciler([{ name: 'app-sonarr', config: {} }], [], state);
  const result = JSON.parse(JSON.stringify(await r.cleanupAppByScan('sonarr', { keepData: true, force: true })));
  // Recorded before the lock and again once admitted (Iris, batch 1).
  assert.deepEqual(state.modes, ['keep', 'keep']);
  assert.match(result.unresolved[0], /it is installed and intact; remove it without --force/);
  // On kept data the shared refusal comes first and records nothing (a refused delete-data request changes nothing).
  const keptState: Parameters<typeof reconciler>[2] = { record: intact, policy: { state: 'retained' } };
  await reconciler([], [], keptState).cleanupAppByScan('sonarr', { keepData: false, force: true });
  assert.equal(keptState.modes, undefined);
  // The route no longer pre-checks outside the lock.
  const route = readFileSync(path.join(root, 'src/app/api/market/uninstall/route.ts'), 'utf8');
  assert.doesNotMatch(route, /forceRemovalApplies/);
});

test('issue 3: the install-url rollback keeps the data of an install that adopted it', () => {
  const route = readFileSync(path.join(root, 'src/app/api/market/install-url/route.ts'), 'utf8');
  assert.match(route, /uninstallApp\(config\.appId, \{ keepData: config\.adoptRetainedData === true \}\)/);
  assert.doesNotMatch(route, /uninstallApp\(config\.appId, \{ keepData: false \}\)/);
});

test('issue 4: an adopted retained.json is not kept data; a preparing or ready one is', async () => {
  const adopted = { appId: 'sonarr', retainedRoots: { schemaVersion: 1, state: 'adopted', roots: [] } };
  assert.equal(await reconciler([], [], { retained: adopted, policy: { state: 'ready' } }).keptDataRefusal('sonarr'), null);
  for (const state of ['preparing', 'ready']) {
    const record = { appId: 'sonarr', retainedRoots: { schemaVersion: 1, state, roots: [] } };
    assert.match(await reconciler([], [], { retained: record, policy: { state: 'ready' } }).keptDataRefusal('sonarr'), /its data is kept/);
  }
  // An adopted record with a retained policy is still refused, by the policy.
  assert.match(await reconciler([], [], { retained: adopted, policy: { state: 'retained' } }).keptDataRefusal('sonarr'), /its data is kept/);
});

test('a keep-data finish by the scan cleanup keeps the dashboard data too', () => {
  const source = readFileSync(path.join(root, 'src/lib/market/reconciler.ts'), 'utf8');
  assert.match(source, /await deregisterAppFromUI\(appId, options\.keepData !== false\);/);
});

test('issue 2, busy lock: a keep request records keep before waiting; a failing attempt never turns keep into delete', async () => {
  // A keep-data request that is refused because the app is busy has still recorded keep (before the lock).
  const uninstaller = readFileSync(path.join(root, 'src/lib/market/uninstaller.ts'), 'utf8');
  assert.match(uninstaller, /return withRemovalRequest\(appId, async \(\) => \{\s*if \(\(options\.keepData \?\? true\) && !options\.preserveAdmission\) await recordRemovalMode\(appId, true\)[^\n]*\n\s*return withAppInventory\(/);
  const reconcilerSource = readFileSync(path.join(root, 'src/lib/market/reconciler.ts'), 'utf8');
  assert.match(reconcilerSource, /return withRemovalRequest\(appId, async \(\) => \{\s*if \(options\.keepData !== false\) await recordRemovalMode\(appId, true\)[^\n]*\n\s*return withAppLifecycle\(appId/);
  // The delete attempt that was running then fails: its end mark keeps the newer keep.
  assert.equal(nextRemovalStage('uninstall-keep-data', 'uninstall-delete-data'), 'uninstall-keep-data');
  assert.equal(nextRemovalStage('uninstall-keep-data', 'scan-cleanup-delete-data'), 'uninstall-keep-data');
  // Everything else is written as it comes: delete over delete, keep over delete, and stages without a mode.
  assert.equal(nextRemovalStage('uninstall-delete-data', 'uninstall-keep-data'), 'uninstall-keep-data');
  assert.equal(nextRemovalStage('uninstall-delete-data', 'scan-cleanup-delete-data'), 'scan-cleanup-delete-data');
  assert.equal(nextRemovalStage(undefined, 'uninstall-delete-data'), 'uninstall-delete-data');
  assert.equal(nextRemovalStage('delete', 'install-rollback'), 'install-rollback');
  const network = readFileSync(path.join(root, 'src/lib/incus/app-network.ts'), 'utf8');
  // Computed from the lease read inside the IPAM write lock (Iris, batch 1; behaviour in removal-mode-under-lock.spec.ts).
  assert.match(network, /mutateIpamState\(\{ config, allowInitialize: false \}, \(current\) => \{\s*const lease = current\.leases\.find\(\(candidate\) => candidate\.appId === appId\);\s*if \(!lease\) return null;\s*const nextStage = lease\.state === 'cleanup_pending' \? nextRemovalStage\(lease\.failure\?\.stage, stage\) : stage;/);
});

// ─── Iris's batch-1 review ──────────────────────────────────────────────────

test('nit d: a delete-data removal clears the stale copies an adoption left, only for an adopted record', async () => {
  const calls: string[] = [];
  const owner = '30000000-0000-4000-8000-000000000003';
  const record = (state: string) => ({ appId: 'sonarr', installationId: OLD, containers: [{ name: 'main', containerName: 'app-sonarr' }],
    retainedRoots: { schemaVersion: 1, state, roots: [{ sourceName: 'app-sonarr', ownerId: owner, retainedName: 'ye-retained-x-0', pool: 'default' }] } });
  let current: unknown = null;
  const retained = load('lib/admission/retained-data.ts', {
    '@/lib/market/metadata': {
      readRetainedInstallMetadata: async () => current,
      removeRetainedInstallMetadata: async (appId: string) => { calls.push(`remove-record ${appId}`); },
    },
    './retained-runtime': { deleteRetainedRuntime: async (binding: { retainedName: string }) => { calls.push(`delete ${binding.retainedName}`); } },
    '../../../../shared/admission': { isUuid: (value: string) => /^[0-9a-f-]{36}$/.test(value), isAppId: () => true },
  });
  assert.equal(await retained.cleanupAdoptedRetainedCopies('sonarr'), false, 'no record');
  for (const state of ['preparing', 'ready']) {
    current = record(state);
    assert.equal(await retained.cleanupAdoptedRetainedCopies('sonarr'), false, `${state} is kept data, never touched`);
  }
  assert.deepEqual(calls, []);
  current = record('adopted');
  assert.equal(await retained.cleanupAdoptedRetainedCopies('sonarr'), true);
  assert.deepEqual(calls, ['delete ye-retained-x-0', 'remove-record sonarr']);
  // Called on both delete-data paths, before the app directory goes.
  const uninstaller = readFileSync(path.join(root, 'src/lib/market/uninstaller.ts'), 'utf8');
  const step6 = uninstaller.slice(uninstaller.indexOf('// 6. Remove volume data and secrets if not keeping'), uninstaller.indexOf('// 7. Remove from installed_apps'));
  assert.match(step6, /if \(!keepData\) \{[\s\S]*await cleanupAdoptedRetainedCopies\(appId\);/);
  const reconcilerSource = readFileSync(path.join(root, 'src/lib/market/reconciler.ts'), 'utf8');
  assert.match(reconcilerSource, /if \(options\.keepData === false\) \{\s*try \{\s*const \{ cleanupAdoptedRetainedCopies \}[^\n]*\n\s*if \(await cleanupAdoptedRetainedCopies\(appId\)\)/);
  assert.ok(reconcilerSource.indexOf('await cleanupAdoptedRetainedCopies(appId)') < reconcilerSource.indexOf('else await removeInstallMetadata(appId);'));
});

test('nit b: a server restore that meets an unfinished keep-data removal stops with the reason', () => {
  const restore = readFileSync(path.join(root, 'src/lib/backup/full-restore.ts'), 'utf8');
  assert.match(restore, /result = await uninstallApp\(appId, \{ keepData: false \}\);\s*\} catch \(error\) \{[\s\S]{0,200}before server restore: \$\{reason\}/);
});

test('a keep-data retry whose containers an earlier delete attempt removed says how to finish (YE-222, live on clone 363)', () => {
  const lifecycle = readFileSync(path.join(root, 'src/lib/admission/lifecycle.ts'), 'utf8');
  const branch = lifecycle.slice(lifecycle.indexOf('if (keepData && !await runtimeExists(container.containerName))'));
  // No retained record: the request names the way to finish, before the generic "Missing retained root recovery map".
  assert.ok(branch.indexOf('if (!await readRetainedInstallMetadata(metadata.appId))') > 0);
  assert.ok(branch.indexOf('if (!await readRetainedInstallMetadata(metadata.appId))') < branch.indexOf('await verifyPreviouslyRetainedRoot('));
  assert.match(branch, /its volumes are kept\. Finish the removal with: youeye app remove \$\{metadata\.appId\} --force --keep-data/);
});
