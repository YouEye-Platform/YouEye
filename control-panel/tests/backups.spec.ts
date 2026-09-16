import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { resolveSharedDatabasePasswordFile } from '../src/lib/backup/manifest-values';
import { recoveryImportErrorMessage } from '../src/lib/backup/platform-backup';
import { assessBackupCompatibility, parseBackupSourceIdentity } from '../src/lib/backup/compatibility';

const root = process.env.CONTROL_PANEL_ROOT || path.join(import.meta.dirname, '..');
const read = (filename: string) => readFileSync(path.join(root, filename), 'utf8');

test('shared database restore reads the manifest-declared password file', () => {
  assert.equal(resolveSharedDatabasePasswordFile({
    secrets: [{ name: 'db_password', file: '.db_password', generator: 'password' }],
  }), '.db_password');
  assert.equal(resolveSharedDatabasePasswordFile({ secrets: [] }), 'db-password');
  assert.throws(() => resolveSharedDatabasePasswordFile({
    secrets: [{ name: 'db_password', file: '../outside', generator: 'password' }],
  }), /outside the app-owned secret directory/);
});

test('recovery import errors stay safe and useful', () => {
  assert.equal(recoveryImportErrorMessage(new Error('Fatal: wrong password or no key found')), 'The recovery key is incorrect.');
  assert.equal(recoveryImportErrorMessage(new Error('repository unavailable at an internal path')), 'Could not read the selected recovery point.');
});

test('recovery-point compatibility rejects newer persistent schemas before restore', () => {
  const current = {
    schema: 'youeye.backup.source.v1', runtime_kind: 'appliance-image', image_version: '0.5.6.0.2.13',
    source_commit: 'a'.repeat(40), release_branch: 'dev', state_schema_version: 2, data_schema_version: 1,
    disk_layout_version: 3, spine_version: '0.5.17.0.2.7', control_panel_version: '0.5.23.0.0.36', ui_version: '0.5.3.0.2.2',
  } as const;
  assert.equal(assessBackupCompatibility(current, current).compatible, true);
  assert.equal(assessBackupCompatibility({ ...current, image_version: '0.5.6.0.2.12' }, current).compatible, true);
  const newer = assessBackupCompatibility({ ...current, state_schema_version: 3 }, current);
  assert.equal(newer.compatible, false);
  assert.match(newer.summary, /newer YouEye System/);
  assert.throws(() => parseBackupSourceIdentity({ ...current, source_commit: undefined }), /incomplete appliance/);
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

test('the sole backup format is canonical v1 without legacy request paths', () => {
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
  assert.match(engine, /Final installation commit failed for \$\{appId\}: \$\{reason\}/);
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
  assert.match(fullRestore, /route\.id\.startsWith\(`app-\$\{app\.appId\}-`\)/);
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
  const update = read('src/components/setup/SetupApplianceUpdate.tsx');
  for (const component of [restore, update]) {
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
