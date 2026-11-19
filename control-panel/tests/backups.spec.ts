import { englishInterfaceSource } from "./helpers/localized-source.mjs";
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { resolveSharedDatabasePasswordFile } from '../src/lib/backup/manifest-values';
import { recoveryImportErrorMessage } from '../src/lib/backup/platform-backup';
import { assessBackupCompatibility, backupSourceIdentityFromStatus, backupYouEyeVersion, parseBackupSourceIdentity } from '../src/lib/backup/compatibility';
import { backupStoreRequest, preservePreRestoreBackup, storeBackupSet } from '../src/lib/backup/platform-backup';
import { SpineAPIError } from '../src/lib/spine/client';

const root = process.env.CONTROL_PANEL_ROOT || path.join(import.meta.dirname, '..');
const read = (filename: string) => englishInterfaceSource(readFileSync(path.join(root, filename), 'utf8'));

test('shared database restore reads the manifest-declared password file', () => {
  assert.equal(resolveSharedDatabasePasswordFile({
    secrets: [{ name: 'db_password', file: 'secrets/db_password', generator: 'password', length: 32 }],
  }), 'secrets/db_password');
  assert.equal(resolveSharedDatabasePasswordFile({ secrets: [] }), 'secrets/db_password');
  for (const file of ['../outside', '.db_password', 'secrets/../install.json', 'install.json']) {
    assert.throws(() => resolveSharedDatabasePasswordFile({
      secrets: [{ name: 'db_password', file, generator: 'password', length: 32 }],
    }), /outside the app-owned secret directory/);
  }
});

test('recovery import errors stay safe and useful', () => {
  assert.equal(recoveryImportErrorMessage(new Error('Fatal: wrong password or no key found')), 'The recovery key is incorrect.');
  assert.equal(recoveryImportErrorMessage(new Error('repository unavailable at an internal path')), 'Could not read the selected recovery point.');
});

test('recovery-point compatibility rejects newer persistent schemas before restore', () => {
  const current = {
    schema: 'youeye.backup.source.v1', runtime_kind: 'appliance-image', image_version: '0.5.6.0.2.13',
    source_tree: 'a'.repeat(40), state_schema_version: 1, data_schema_version: 1,
    disk_layout_version: 3, spine_version: '0.5.17.0.2.7', control_panel_version: '0.5.23.0.0.36', ui_version: '0.5.3.0.2.2',
  } as const;
  assert.equal(assessBackupCompatibility(current, current).compatible, true);
  assert.equal(assessBackupCompatibility({ ...current, image_version: '0.5.6.0.2.12' }, current).compatible, true);
  const newer = assessBackupCompatibility({ ...current, state_schema_version: 3 }, current);
  assert.equal(newer.compatible, false);
  assert.match(newer.summary, /newer YouEye System/);
  assert.throws(() => parseBackupSourceIdentity({ ...current, source_tree: undefined }), /incomplete appliance/);
});

test('restore refuses a recovery point made by a newer Control Panel, UI or Pointer build', () => {
  const current = {
    schema: 'youeye.backup.source.v1', runtime_kind: 'appliance-image', image_version: '0.6.5-dev.2',
    source_tree: 'a'.repeat(40), state_schema_version: 1, data_schema_version: 1, disk_layout_version: 1,
    spine_version: '0.6.5-dev.2', control_panel_version: '0.6.5-dev.2', ui_version: '0.6.5-dev.2', pointer_version: '0.6.3-dev.1',
  } as const;
  assert.equal(assessBackupCompatibility({ ...current, control_panel_version: '0.6.5-dev.1' }, current).compatible, true);
  for (const [field, label] of [['control_panel_version', /newer Control Panel/], ['ui_version', /newer UI/], ['pointer_version', /newer Pointer/]] as const) {
    const result = assessBackupCompatibility({ ...current, [field]: '0.6.6-dev.1' }, current);
    assert.equal(result.compatible, false);
    assert.match(result.summary, label);
    assert.match(result.summary, /Update this box/);
  }
  // A component the box no longer runs is not a reason to refuse.
  assert.equal(assessBackupCompatibility({ ...current, pointer_version: '0.6.9-dev.1' }, { ...current, pointer_version: undefined }).compatible, true);
});

test('backups record releases by line, sequence and tree, alongside the old build names, and compare by them', () => {
  const tree = (c: string) => c.repeat(40);
  const status = {
    spine: { version: '0.6.12-dev.3' }, incus: { version: '6' }, control_panel: { status: 'running', version: '0.6.12-dev.3' },
    ui: { status: 'running', installed: true, enabled: true, version: '0.6.12-dev.3' }, host: { os: 'Debian' },
    runtime: { kind: 'appliance-image', manifest_valid: true, repair_required: false, image_version: '0.6.12-dev.3', source_tree: tree('a'), capabilities: {} },
    persistent_state: { available: true, state_schema_version: 1, data_schema_version: 1, disk_layout_version: 1, compatibility: { state: 'ok', data: 'ok', compatible: true, repair_required: false }, slots: { current: 'a', current_image_version: '0.6.12-dev.3' } },
  } as never;
  const core = (version: string, sequence: number, cpTree: string, build?: string) => ({ version, sequence, source_tree: tree('a'), members: [
    { role: 'cp', source_tree: cpTree, ...(build ? { build_version: build } : {}) },
    { role: 'ui', source_tree: tree('d'), ...(build ? { build_version: build } : {}) },
  ] }) as never;
  const pointer = (version: string, sequence: number, build?: string) => ({ release: { version, sequence, source_tree: tree('e') }, build: build ? { build_version: build } : {} }) as never;
  // An old-shape release (0.6.12): both shapes are recorded; the build names are the documents' (not version.json's).
  const promoted = backupSourceIdentityFromStatus(status, undefined, { core: core('0.6.12-beta.1', 100, tree('c'), '0.6.12-dev.2'), pointer: pointer('0.6.3', 50, '0.6.3-dev.4') });
  assert.equal(promoted.control_panel_version, '0.6.12-dev.2');
  assert.equal(promoted.pointer_version, '0.6.3-dev.4');
  assert.deepEqual(promoted.release, { version: '0.6.12-beta.1', line: '0.6.12', sequence: 100, source_tree: tree('a') });
  assert.deepEqual(promoted.control_panel, { version: '0.6.12-beta.1', line: '0.6.12', sequence: 100, source_tree: tree('c') });
  assert.deepEqual(promoted.pointer, { version: '0.6.3', line: '0.6.3', sequence: 50, source_tree: tree('e') });
  assert.deepEqual(parseBackupSourceIdentity(JSON.parse(JSON.stringify(promoted))), promoted);
  // A new-shape release (0.6.13) has no build names: its version stands in for the old fields.
  const clean = backupSourceIdentityFromStatus(status, undefined, { core: core('0.6.13', 200, tree('f')), pointer: pointer('0.6.4', 60) });
  assert.equal(clean.control_panel_version, '0.6.13');
  assert.equal(clean.pointer_version, '0.6.4');
  // Spine (same build) stores the whole identity: the store request carries the release keys.
  const stored = backupStoreRequest({ schema: 'youeye.backup.set.v1', id: 'backup-20261119T000000Z-0a1b2c3d', createdAt: '2026-11-19T00:00:00.000Z',
    status: 'completed', appCount: 0, apps: [], source: clean }, 'media-1', undefined, true).source;
  assert.deepEqual(stored, clean);
  assert.deepEqual(stored.release, { version: '0.6.13', line: '0.6.13', sequence: 200, source_tree: tree('a') });

  // Newer software made the backup: refused, naming versions only.
  const refused = assessBackupCompatibility(clean, promoted);
  assert.equal(refused.compatible, false);
  assert.match(refused.summary, /newer Control Panel \(0\.6\.13; this box runs 0\.6\.12-beta\.1\)/);
  assert.equal(assessBackupCompatibility(promoted, clean).compatible, true);
  assert.match(assessBackupCompatibility(promoted, clean).summary, /YouEye 0\.6\.12-beta\.1 recovery data can be migrated by this YouEye 0\.6\.13 server/);
  // Labels never decide: the same build under another name, or the same tree, is the same software.
  const sameBuild = backupSourceIdentityFromStatus(status, undefined, { core: core('0.6.12-dev.2', 100, tree('c'), '0.6.12-dev.2'), pointer: pointer('0.6.3-dev.4', 50, '0.6.3-dev.4') });
  assert.equal(assessBackupCompatibility(sameBuild, promoted).compatible, true);
  const laterSameTree = backupSourceIdentityFromStatus(status, undefined, { core: core('0.6.12-dev.5', 150, tree('c'), '0.6.12-dev.5'), pointer: pointer('0.6.3', 50, '0.6.3-dev.4') });
  assert.equal(assessBackupCompatibility(laterSameTree, promoted).compatible, true, 'reused parts (same trees) are not newer');
  const newerUI = assessBackupCompatibility({ ...laterSameTree, ui: { ...laterSameTree.ui!, source_tree: tree('9') } }, promoted);
  assert.equal(newerUI.compatible, false, 'a UI of a newer release is');
  assert.match(newerUI.summary, /newer UI \(0\.6\.12-dev\.5; this box runs 0\.6\.12-beta\.1\)/);

  // A backup from before 0.6.12 (build names only): by line, then the old build rule against the box's own build.
  const { release: _r, control_panel: _c, ui: _u, pointer: _p, ...older } = promoted;
  const old = { ...older, control_panel_version: '0.6.11-dev.6', ui_version: '0.6.11-dev.6', pointer_version: '0.6.3-dev.4' };
  assert.equal(assessBackupCompatibility(old, promoted).compatible, true);
  assert.equal(assessBackupCompatibility(old, clean).compatible, true);
  assert.equal(assessBackupCompatibility({ ...old, control_panel_version: '0.6.12-dev.3' }, promoted).compatible, false, 'dev.3 is newer than dev.2 within the line');
  assert.equal(assessBackupCompatibility({ ...old, control_panel_version: '0.6.12-dev.1' }, promoted).compatible, true);
  assert.equal(assessBackupCompatibility({ ...old, control_panel_version: '0.6.14-dev.1' }, clean).compatible, false);
  assert.equal(assessBackupCompatibility(old, { ...clean, control_panel_version: undefined, ui_version: undefined }).compatible, true, 'a line is enough');
  // A backup shows the release that made it; an older one shows none.
  assert.equal(backupYouEyeVersion(promoted), '0.6.12-beta.1');
  assert.equal(backupYouEyeVersion(old), undefined);
  assert.throws(() => parseBackupSourceIdentity({ ...promoted, release: { ...promoted.release, line: '0.6.12-dev.2' } }), /YouEye release is invalid/);
});

test('authenticated backup metadata binds source identity before live restore mutation', () => {
  const platform = read('src/lib/backup/platform-backup.ts');
  const core = read('src/lib/backup/core-backup.ts');
  const app = read('src/lib/backup/app-backup.ts');
  const fullRestore = read('src/lib/backup/full-restore.ts');
  const appRestore = read('src/lib/backup/app-restore.ts');
  const repository = read('../spine/internal/backup/repository.go');
  assert.match(platform, /readCurrentBackupSourceIdentity/);
  assert.match(platform, /sourceIdentity: source/);
  assert.match(core, /youeye\.backup\.core-meta\.v1/);
  assert.match(core, /databases: backedUpDatabases/);
  assert.match(app, /youeye\.backup\.app-meta\.v1/);
  assert.match(repository, /VerifiedAt[\s\S]*Source.*\*BackupSourceIdentity/);
	assert.match(platform, /record\.status = 'failed';[\s\S]*await rm\(root, \{ recursive: true, force: true \}\)/);
  assert.ok(fullRestore.indexOf('assessBackupCompatibility') < fullRestore.indexOf("emit('remove-current-apps'"));
  assert.ok(appRestore.indexOf('assessBackupCompatibility') < appRestore.indexOf("emit('uninstall'"));
});

test('Backups keeps core mandatory and makes app selection explicit', () => {
  const platform = read('src/lib/backup/platform-backup.ts');
  const settings = read('src/components/settings-shell/backup-client.tsx');
  const setup = read('src/components/setup/SetupRestore.tsx');
  assert.match(platform, /await backupCore\(/);
  assert.match(platform, /selectedAppIds/);
  assert.match(platform, /Backup selection contains an app that is not installed/);
  assert.match(settings, /YouEye server[\s\S]*Always included/);
  assert.match(settings, /Restore individual apps without changing the rest of the server/);
  assert.match(setup, /appIds: selectedApps/);
  assert.match(setup, /YouEye configuration, accounts, and server identity are always restored/);
  assert.match(setup, /fetch\('\/api\/auth\/csrf'/);
  assert.doesNotMatch(setup, /fetch\('\/settings\/api\/auth\/csrf'/);
});

test('the sole backup format is canonical v1 with one set of request paths', () => {
  const platform = read('src/lib/backup/platform-backup.ts');
  const restoreRoute = read('src/app/api/backup/restore/route.ts');
  const spineClient = read('src/lib/spine/client.ts');
  const spineRepository = read('../spine/internal/backup/repository.go');
  const spineRunner = read('../spine/internal/backup/runner.go');
  const spineServer = read('../spine/internal/api/server.go');
  const spineCommand = read('../spine/internal/cmd/backup.go');
  const setupRestore = read('src/app/api/setup/restore/route.ts');
  const currentImplementation = [
    platform,
    restoreRoute,
    spineClient,
    spineRepository,
    spineRunner,
    spineServer,
  ].join('\n');

  assert.match(platform, /youeye\.backup\.set\.v1/);
  assert.match(restoreRoute, /youeye\.backup\.set\.v1/);
  assert.match(spineRepository, /youeye\.recovery\.catalog\.v1/);
  assert.match(spineRepository, /youeye-v1/);
  assert.doesNotMatch(currentImplementation, /youeye\.backup\.set\.(?!v1)|youeye\.recovery\.catalog\.(?!v1)|youeye-v(?!1)/);
  assert.doesNotMatch(spineRunner, /VolumePaths|stop-containers|backup_type[^\n]*full/);
  assert.doesNotMatch(spineServer, /\/api\/backup\/(?:list|prune|volumes)|handleBackup(?:List|Prune|Volumes)/);
  assert.doesNotMatch(spineClient, /getBackupList|pruneBackups/);
  assert.match(spineCommand, /"mediaId":\s+restoreMediaID/);
  assert.doesNotMatch(spineCommand, /backupExportCmd/);
  assert.doesNotMatch(setupRestore, /body\.backupPath|\/mnt\/backup/);
  assert.equal(existsSync(path.join(root, 'src/lib/backup/service.ts')), false);
  assert.equal(existsSync(path.join(root, '../spine/internal/backup/index.go')), false);
  assert.equal(existsSync(path.join(root, '../spine/internal/cmd/backup_export.go')), false);
});

test('database and application restore failures cannot be reported as success', () => {
  const appBackup = read('src/lib/backup/app-backup.ts');
  const appRestore = read('src/lib/backup/app-restore.ts');
  const manifestValues = read('src/lib/backup/manifest-values.ts');
  const fullRestore = read('src/lib/backup/full-restore.ts');
  const engine = read('src/lib/market/engine.ts');
  const installedApps = read('src/lib/market/installed-apps.ts');
  assert.match(appBackup, /Required shared database dump failed/);
  assert.match(appBackup, /Required application database dump failed/);
  assert.match(appBackup, /resolveOwnPostgres\(backupSection\.ownPostgres, appId\)/);
  assert.match(appRestore, /resolveOwnPostgres\(/);
  assert.match(manifestValues, /\.replaceAll\('\$\{app\.id\}', appId\)/);
  assert.match(manifestValues, /user: resolveAppManifestValue\(value\.user \|\| database, appId\)/);
  assert.match(manifestValues, /secret\.name === 'db_password'/);
  assert.match(appRestore, /resolveSharedDatabasePasswordFile\(manifest\)/);
  assert.match(appRestore, /validateOwnPostgresStorageContract/);
  assert.match(appRestore, /Restored the encrypted database dump/);
  assert.match(appRestore, /startTracking\(appId, manifest\.metadata\.name\)/);
  assert.match(appRestore, /finishTracking\(appId/);
  assert.match(appRestore, /beginContainerMaintenance\(containers/);
  assert.match(appRestore, /maintenance\.release\(\)/);
  assert.match(installedApps, /if \(meta\.lifecycleState !== 'active'\) continue/);
  assert.match(appRestore, /Protecting the current .* state before restore/);
  assert.match(appRestore, /returned to its previous state/);
  assert.match(appRestore, /post-restore health check/);
  assert.match(appRestore, /skipSecrets:\s*true/);
  assert.match(appRestore, /skipDatabase:\s*true/);
  assert.match(appRestore, /skipConfigFiles:\s*true/);
  assert.match(appRestore, /prepareIncusRecovery/);
  assert.match(appRestore, /runtimeImages/);
  assert.match(appRestore, /runtimeInstances/);
  assert.match(engine, /Recovered native runtime has no target app network/);
  assert.match(engine, /network: recoveryNetwork/);
  assert.ok(appRestore.indexOf('applyBackupVolumes(stagingDir)') < appRestore.indexOf('await installApp('), 'restored volumes must be live before reinstall reads secrets');
  assert.ok(appRestore.indexOf('removeInstallMetadataRecord(appId)') < appRestore.indexOf('await installApp('), 'restored lifecycle metadata must be cleared without deleting app data before reinstall');
  assert.doesNotMatch(appRestore, /Warning: Database restore failed/);
  assert.match(fullRestore, /throw new Error\(`Failed to restore \$\{appId\}/);
  assert.match(fullRestore, /missing required database dumps/);
  assert.match(engine, /if \(!restoreOptions\) \{[\s\S]*Shared database collision preflight/);
  assert.match(engine, /Network isolation failed for \$\{appId\}: \$\{reason\}/);
  assert.match(engine, /logOperationFailure\(`Final installation commit of \$\{appId\}`, error\);\s*await rollbackInstall/);
});

test('PostgreSQL readiness uses structured arguments and the command exit status', () => {
  const health = read('src/lib/market/health.ts');
  const incus = read('src/lib/incus/server.ts');
  assert.match(health, /\^\[A-Za-z_\]/);
  assert.match(health, /execCommand\(containerName, \[executable, '-U', user\]/);
  assert.match(health, /result\.exitCode === 0/);
  assert.doesNotMatch(health, /execShell\(containerName/);
  assert.doesNotMatch(health, /accepting connections/);
  assert.match(incus, /if \(response\.type === 'error'\)/);
  assert.match(incus, /if \(opResponse\.type === 'error'\)/);
  assert.doesNotMatch(incus, /Unexpected exec response format/);
});

test('whole-server recovery removes omitted app registrations and keeps setup gated', () => {
  const fullRestore = read('src/lib/backup/full-restore.ts');
  const setupRoute = read('src/app/api/setup/restore/route.ts');
  assert.match(fullRestore, /clearRestoredAppRegistration/);
  assert.match(fullRestore, /for \(const restoredApp of restoredApps\)/);
  assert.match(fullRestore, /route\.hostname === hostname/);
  // Exact hostname only: no `app-<id>-` prefix matching (cleaning up `foo` never touches `foo-bar`).
  assert.doesNotMatch(fullRestore, /startsWith\(`app-/);
  assert.match(fullRestore, /Routing registration remains/);
  assert.match(fullRestore, /restoreApp\([\s\S]*false,/);
  assert.match(fullRestore, /setup_completed: false/);
  assert.match(fullRestore, /prepareSetupRestoreVolumeMap/);
  assert.match(fullRestore, /SETUP_RESTORABLE_CORE_VOLUMES/);
  assert.match(fullRestore, /SETUP_PRESERVED_MACHINE_CONFIG/);
  assert.match(fullRestore, /captureSetupMachineConfig/);
  assert.match(fullRestore, /restoreSetupMachineConfig/);
  assert.match(fullRestore, /\/var\/lib\/youeye\/config\/cli-token/);
  assert.match(fullRestore, /\/var\/lib\/youeye\/config\/config\.yaml/);
  assert.ok(fullRestore.indexOf('captureSetupMachineConfig()') < fullRestore.indexOf('applyBackupVolumes(coreStagingDir)'), 'target runtime credentials must be captured before restoring the source config volume');
  assert.ok(fullRestore.indexOf('restoreSetupMachineConfig(machineConfig)') > fullRestore.indexOf('applyBackupVolumes(coreStagingDir)'), 'target runtime credentials must be restored after applying the source config volume');
  assert.match(fullRestore, /reconcileSetupRuntime/);
  assert.match(fullRestore, /replaceSetupContainerRoute/);
  assert.match(fullRestore, /route\.hostname === hostname && route\.path === '\/\*'/);
  assert.match(fullRestore, /configureUIIdentitySSO/);
  assert.match(fullRestore, /configureControlPanelIdentitySSO/);
  assert.match(fullRestore, /setDomainDNS/);
  assert.match(fullRestore, /Imported TLS certificate is not portable to this appliance/);
  assert.match(fullRestore, /await tlsStorage\.revertToInternal\(\)/);
  assert.match(setupRoute, /setupMode: true/);
  assert.match(setupRoute, /await spineClient\.patchConfig\(\{ setup_completed: true \}\)/);
  assert.doesNotMatch(setupRoute, /Failed to mark setup as complete/);
});

test('setup-only protected actions use the setup CSRF endpoint', () => {
  const restore = read('src/components/setup/SetupRestore.tsx');
  for (const component of [restore]) {
    assert.match(component, /fetch\('\/api\/auth\/csrf'/);
    assert.doesNotMatch(component, /fetch\('\/settings\/api\/auth\/csrf'/);
  }
});

test('automatic backups use the protected key and removable-drive identity', () => {
  const scheduler = read('src/lib/backup/scheduler.ts');
  const instrumentation = read('src/instrumentation.ts');
  const mediaRoute = read('src/app/api/backup/media/route.ts');
  assert.match(instrumentation, /startBackupScheduler/);
  assert.match(scheduler, /useStoredPassphrase: true/);
  assert.match(scheduler, /Waiting for the configured backup drive/);
	assert.match(scheduler, /selectedAppIds,/);
	assert.match(scheduler, /dueApps\(config, now\)/);
  assert.match(mediaRoute, /storeBackupRecoveryKey/);
  assert.doesNotMatch(`${scheduler}\n${mediaRoute}`, /searchParams.*passphrase/);
});

test('Settings polls media without replacing the page during an operation', () => {
  const settings = read('src/components/settings-shell/backup-client.tsx');
  const settingsMediaRoute = read('src/app/settings/api/backup/media/route.ts');
  assert.match(settings, /setInterval\(\(\) => \{ if \(!busy\) void load\(false\); \}, 5000\)/);
  assert.match(settings, /Progress value=\{progress\}/);
  assert.doesNotMatch(settings, /window\.location|router\.refresh/);
  assert.match(settingsMediaRoute, /export const dynamic = 'force-dynamic'/);
  assert.doesNotMatch(settingsMediaRoute, /export \{ POST, dynamic \}/);
});

test('a 0.6.11 Spine (the other slot) that refuses the release keys gets the backup once more with only its fields', async () => {
  const tree = (c: string) => c.repeat(40);
  const source = parseBackupSourceIdentity({ schema: 'youeye.backup.source.v1', runtime_kind: 'mutable-host', spine_version: '0.6.12-dev.3',
    control_panel_version: '0.6.12-dev.3', ui_version: '0.6.12-dev.3', pointer_version: '0.6.3-dev.4',
    release: { version: '0.6.12-beta.1', line: '0.6.12', sequence: 100, source_tree: tree('a') },
    control_panel: { version: '0.6.12-beta.1', line: '0.6.12', sequence: 100, source_tree: tree('b') } });
  const request = backupStoreRequest({ schema: 'youeye.backup.set.v1', id: 'backup-20261119T000000Z-0a1b2c3d', createdAt: '2026-11-19T00:00:00.000Z',
    status: 'completed', appCount: 0, apps: [], source }, 'media-1', undefined, true);
  const oldSpine = (refusal: SpineAPIError) => {
    const sent: Record<string, unknown>[] = [];
    return { sent, store: async (body: typeof request) => {
      sent.push(structuredClone(body.source) as unknown as Record<string, unknown>);
      if ('release' in body.source || 'control_panel' in body.source) throw refusal;
    } };
  };
  // 0.6.11's strict decoder answers 400 "invalid repository store request" (it does not name the field).
  const spine = oldSpine(new SpineAPIError('invalid repository store request', 400));
  await storeBackupSet(request, spine.store);
  assert.equal(spine.sent.length, 2);
  assert.deepEqual(Object.keys(spine.sent[1]), ['schema', 'runtime_kind', 'spine_version', 'control_panel_version', 'ui_version', 'pointer_version']);
  // The same Spine as the Control Panel: one request with everything.
  const same = oldSpine(new SpineAPIError('unused', 400));
  const { release: _release, control_panel: _cp, ...oldShape } = source;
  await storeBackupSet({ ...request, source: oldShape }, same.store);
  assert.equal(same.sent.length, 1);
  // Any other refusal is the answer: no second request.
  for (const refusal of [new SpineAPIError('Could not store recovery point: no drive', 400), new SpineAPIError('invalid repository store request', 500)]) {
    const other = oldSpine(refusal);
    await assert.rejects(storeBackupSet(request, other.store), new RegExp(refusal.message));
    assert.equal(other.sent.length, 1, refusal.message);
  }
  // Refused again with the old fields: that refusal is reported.
  let calls = 0;
  await assert.rejects(storeBackupSet(request, async () => { calls++; throw new SpineAPIError('invalid repository store request', 400); }), /invalid repository store request/);
  assert.equal(calls, 2);
});

test('after a failed rollback the pre-restore backup goes to the backup drive, or stays on the server', async () => {
  const record = { schema: 'youeye.backup.set.v1' as const, id: 'backup-20261119T154500Z-0a1b2c3d', createdAt: '2026-11-19T15:45:00.000Z',
    status: 'completed' as const, appCount: 2, apps: ['memos', 'notes'], reason: 'pre-restore' as const, sizeBytes: 10,
    source: { schema: 'youeye.backup.source.v1' as const, runtime_kind: 'appliance-image' as const, spine_version: '0.6.13' } };
  const stored: Array<Record<string, unknown>> = [];
  const removed: string[] = [];
  const where = await preservePreRestoreBackup(record, 'drive-1', 'fixture-recovery-key',
    async request => { stored.push(request as unknown as Record<string, unknown>); }, async root => { removed.push(root); });
  // Stored like any set, so the restore page lists it: its apps, its time, its reason.
  assert.equal(stored.length, 1);
  assert.deepEqual([stored[0].media_id, stored[0].backup_id, stored[0].reason, stored[0].apps],
    ['drive-1', record.id, 'pre-restore', ['memos', 'notes']]);
  assert.deepEqual(removed, [`/var/lib/youeye/backups/sets/${record.id}`], 'the local copy goes once the drive has it');
  assert.match(where, /^saved on the backup drive as recovery point backup-20261119T154500Z-0a1b2c3d/);

  // A drive that cannot take it: nothing is deleted.
  removed.length = 0;
  const kept = await preservePreRestoreBackup(record, 'drive-1', 'fixture-recovery-key',
    async () => { throw new Error('no space left on device'); }, async root => { removed.push(root); });
  assert.deepEqual(removed, []);
  assert.equal(kept, `kept on the server in /var/lib/youeye/backups/sets/${record.id}`);
});
