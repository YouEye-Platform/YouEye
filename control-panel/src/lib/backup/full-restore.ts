/**
 * Full platform restore orchestrator.
 *
 * Restores the entire YouEye platform from a backup:
 * 1. Decrypt + extract core backup
 * 2. Restore youeye.yaml config
 * 3. Restore infrastructure secrets
 * 4. Restore the YouEye database (including YouEye ID)
 * 5. Restore Caddy and Pi-Hole configuration
 * 6. For each app archive: restoreApp()
 */

import { chmod, readFile, mkdir, rm, writeFile } from 'fs/promises';
import { existsSync, readdirSync } from 'fs';
import path from 'path';
import { spineClient } from '@/lib/spine/client';
import { execCommand, incusRequest, incusUploadFile } from '@/lib/incus/server';
import {
  getRoutes,
  removeAppRoutes,
  removeRoute,
  setConfig as setCaddyConfig,
} from '@/lib/caddy/client';
import { restoreApp } from './app-restore';
import { listInstalledApps } from '@/lib/market/metadata';
import { uninstallApp } from '@/lib/market/uninstaller';
import { getClient } from '@/lib/identity/store';
import { removeForwardAuth, removeOAuthClient } from '@/lib/identity/provider';
import type {
  FullRestoreConfig,
  BackupEvent,
  BackupEventCallback,
} from './types';
import { BACKUP_STAGING_ROOT, runningContainers } from './workspace';
import { isPlatformDatabase, PLATFORM_DATABASES, replacePlatformDatabase } from './postgres';
import { assessBackupCompatibility, readCurrentBackupSourceIdentity } from './compatibility';
import * as caddy from '@/lib/caddy/client';
import { setDomainDNS } from '@/lib/apps/pihole-api';
import { getIdentityConfig } from '@/lib/identity/config';
import {
  configureControlPanelIdentitySSO,
  configureUIIdentitySSO,
} from '@/lib/identity/core-clients';
import { tlsStorage } from '@/lib/acme/storage';
import { configurePointerForPlatform } from '@/lib/infrastructure/deployer';

const STAGING_BASE = path.join(BACKUP_STAGING_ROOT, 'restore');
const RESTORE_CONTAINER_START_ATTEMPTS = 5;
const RESTORE_CONTAINER_START_DELAY_MS = 1500;
const CORE_VOLUME_MAP_SCHEMA = 'youeye.backup.volume-map.v1';
const SETUP_RESTORABLE_CORE_VOLUMES = new Set([
  '/var/lib/youeye/config',
  '/var/lib/youeye/pihole',
  '/var/lib/youeye/pointer',
]);
const SETUP_PRESERVED_MACHINE_CONFIG = [
  '/var/lib/youeye/config/cli-token',
  '/var/lib/youeye/config/config.yaml',
] as const;
const KNOWN_CORE_VOLUMES = new Set([
  '/var/lib/youeye/caddy',
  '/var/lib/youeye/pihole',
  '/var/lib/youeye/config',
  '/var/lib/youeye/networks',
  '/var/lib/youeye/ui',
  '/var/lib/youeye/pointer',
]);

interface RestoredAppInventory {
  appId: string;
  subdomain?: string;
  domain?: string;
  ssoClientId?: string;
  ssoSlug?: string;
  enableSSO?: boolean;
  forwardAuthEnabled?: boolean;
}

interface CoreVolumeMapping {
  source: string;
  archive_path: string;
}

interface PreservedMachineConfig {
  path: typeof SETUP_PRESERVED_MACHINE_CONFIG[number];
  contents: Buffer | null;
}

async function captureSetupMachineConfig(): Promise<PreservedMachineConfig[]> {
  return Promise.all(SETUP_PRESERVED_MACHINE_CONFIG.map(async filePath => {
    try {
      return { path: filePath, contents: await readFile(filePath) };
    } catch {
      return { path: filePath, contents: null };
    }
  }));
}

async function restoreSetupMachineConfig(files: PreservedMachineConfig[]): Promise<void> {
  for (const file of files) {
    if (file.contents === null) {
      await rm(file.path, { force: true });
      continue;
    }
    await writeFile(file.path, file.contents, { mode: 0o600 });
    await chmod(file.path, 0o600);
  }
}

async function prepareSetupRestoreVolumeMap(coreStagingDir: string): Promise<void> {
  const volumeMapPath = path.join(coreStagingDir, 'volume-map.json');
  const document = JSON.parse(await readFile(volumeMapPath, 'utf8')) as {
    schema?: unknown;
    volumes?: unknown;
  };
  if (document.schema !== CORE_VOLUME_MAP_SCHEMA || !Array.isArray(document.volumes)) {
    throw new Error('Core backup contains an invalid volume map');
  }

  const volumes = document.volumes as CoreVolumeMapping[];
  for (const mapping of volumes) {
    const source = typeof mapping?.source === 'string'
      ? path.posix.normalize(mapping.source.replace(/\/$/, ''))
      : '';
    if (!source || typeof mapping?.archive_path !== 'string' || !KNOWN_CORE_VOLUMES.has(source)) {
      throw new Error('Core backup contains an unsupported setup volume');
    }
    mapping.source = source;
  }

  // A fresh appliance owns its generated runtime wiring. Importing the old
  // Caddy state, network leases, or UI database endpoint can disconnect the
  // setup browser and point services at the source appliance. Restore only
  // portable persistent state; the structured config/database records below
  // rebuild the target-specific service bindings.
  const portable = volumes.filter(mapping => SETUP_RESTORABLE_CORE_VOLUMES.has(mapping.source));
  await writeFile(
    volumeMapPath,
    `${JSON.stringify({ schema: CORE_VOLUME_MAP_SCHEMA, volumes: portable }, null, 2)}\n`,
    { mode: 0o600 },
  );
}

async function replaceSetupContainerRoute(
  domain: string,
  containerName: string,
  containerPort: number,
  subdomain: string,
): Promise<void> {
  const hostname = subdomain ? `${subdomain}.${domain}` : domain;
  // A setup restore can be retried after a later stage fails. Remove only the
  // exact full-host route created by an earlier attempt; root-domain Settings
  // and other path-specific routes remain intact and are reconciled below.
  for (const route of await caddy.getRoutes()) {
    if (route.id !== 'default-catchall' && route.hostname === hostname && route.path === '/*') {
      await caddy.removeRoute(route.id);
    }
  }
  const result = await caddy.setContainerRoute(domain, containerName, containerPort, 'subdomain', subdomain);
  if (!result.success) throw new Error(result.error || `${containerName} route setup failed`);
}

async function reconcileSetupRuntime(spineConfig: Record<string, unknown>): Promise<void> {
  const domain = typeof spineConfig.domain === 'string' ? spineConfig.domain.trim() : '';
  const subdomains = spineConfig.subdomains && typeof spineConfig.subdomains === 'object'
    ? spineConfig.subdomains as Record<string, string>
    : {};
  if (!domain) throw new Error('Restored server configuration has no domain');

  const controlSubdomain = typeof subdomains.control === 'string' && subdomains.control
    ? subdomains.control
    : 'control';
  const identitySubdomain = typeof subdomains.identity === 'string' && subdomains.identity
    ? subdomains.identity
    : 'id';
  const uiSubdomain = typeof subdomains.ui === 'string' ? subdomains.ui : '';
  const uiHost = uiSubdomain ? `${uiSubdomain}.${domain}` : domain;

  const postgres = await spineClient.getPostgresCredentials();
  const databaseUrl = `postgresql://${postgres.user}:${encodeURIComponent(postgres.password)}@${postgres.host}:${postgres.port}/youeye_ui`;
  await configureUIIdentitySSO({ uiExternalUrl: `https://${uiHost}`, databaseUrl });
  await configureControlPanelIdentitySSO({
    controlExternalUrl: `https://${controlSubdomain}.${domain}`,
    settingsExternalUrl: `https://${domain}/settings`,
  });

  await caddy.setDomain(domain);
  await replaceSetupContainerRoute(domain, 'youeye-control', 3000, controlSubdomain);
  const identity = await getIdentityConfig();
  await caddy.ensureIdentityRoute(`${identitySubdomain}.${domain}`, identity.containerName, identity.port);
  await replaceSetupContainerRoute(domain, 'youeye-ui', 3000, uiSubdomain);
  await caddy.ensureControlSettingsRoute(domain, 'youeye-control', 3000);
  await caddy.setDefaultRoute('youeye-control', 3000);
  await caddy.ensurePingRoute('youeye-control', 3000);
  await caddy.ensureHeaderStrippingRoute();
  await caddy.migrateSystemUpstreamsToIPv4();

  try {
    const storedCert = await tlsStorage.getCert();
    if (storedCert && (storedCert.mode === 'acme' || storedCert.mode === 'manual')) {
      await caddy.loadExternalCert(storedCert.certPem, storedCert.keyPem, storedCert.domains);
    }
  } catch (error) {
    // TLS private keys at rest are authenticated with the source appliance's
    // deployment secret, which is deliberately machine-local and excluded
    // from recovery points. Never copy or weaken that key boundary. A fresh
    // server keeps the internal certificate configured by setDomain(); clear
    // only the unusable imported certificate metadata so recovery can finish
    // and the owner can reconnect managed/public TLS through its normal flow.
    console.warn('[restore] Imported TLS certificate is not portable to this appliance; using internal TLS:', error);
    await tlsStorage.revertToInternal();
  }

  await configurePointerForPlatform();
  await caddy.ensurePointerInferenceRoutes(domain);
}

function parseRestoredAppInventory(value: unknown): RestoredAppInventory[] {
  if (!Array.isArray(value)) throw new Error('Core backup contains an invalid installed-app inventory');
  const result: RestoredAppInventory[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object') throw new Error('Core backup contains an invalid installed-app inventory');
    const item = candidate as Record<string, unknown>;
    if (typeof item.appId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(item.appId) || seen.has(item.appId)) {
      throw new Error('Core backup contains an invalid or duplicate app identifier');
    }
    seen.add(item.appId);
    result.push({
      appId: item.appId,
      subdomain: typeof item.subdomain === 'string' ? item.subdomain : undefined,
      domain: typeof item.domain === 'string' ? item.domain : undefined,
      ssoClientId: typeof item.ssoClientId === 'string' ? item.ssoClientId : undefined,
      ssoSlug: typeof item.ssoSlug === 'string' ? item.ssoSlug : undefined,
      enableSSO: item.enableSSO === true,
      forwardAuthEnabled: item.forwardAuthEnabled === true,
    });
  }
  return result;
}

async function removeCurrentApp(appId: string): Promise<void> {
  const result = await uninstallApp(appId, { dropSharedDatabase: true, keepData: false });
  if (!result.success) throw new Error(`Could not clear the current ${appId} installation before server restore`);
}

async function clearRestoredAppRegistration(app: RestoredAppInventory): Promise<void> {
  // Core databases and network/routing configuration contain the app inventory,
  // while app archives own the actual reinstall. Clear every restored app
  // registration first so omitted apps stay omitted and selected apps get a
  // collision-free, manifest-driven reinstall.
  const result = await uninstallApp(app.appId, { dropSharedDatabase: false, keepData: true });
  if (!result.success) {
    const detail = result.errors.length > 0 ? `: ${result.errors.join('; ')}` : '';
    throw new Error(`Could not reconcile restored registration for ${app.appId}${detail}`);
  }

  // The core archive owns Caddy's complete configuration, but app install
  // metadata lives with each app archive. After current apps are removed the
  // restored primary route can therefore have a generic `route-*` identifier
  // with no live install metadata for uninstallApp() to associate with the
  // app. Remove it using the independently validated core inventory before
  // the selected app's manifest-driven reinstall runs its collision preflight.
  const hostname = app.subdomain && app.domain ? `${app.subdomain}.${app.domain}` : '';
  for (const route of await getRoutes()) {
    if ((hostname && route.hostname === hostname) || route.id.startsWith(`app-${app.appId}-`)) {
      await removeRoute(route.id);
    }
  }
  await removeAppRoutes(app.appId);
  const remainingRoutes = await getRoutes();
  if (remainingRoutes.some(route => (hostname && route.hostname === hostname)
    || route.id.startsWith(`app-${app.appId}-`))) {
    throw new Error(`Routing registration remains for ${app.appId}`);
  }

  const clientID = app.ssoClientId || app.ssoSlug || (app.enableSSO ? `youeye-app-${app.appId}` : '');
  if (clientID) {
    await removeOAuthClient(clientID);
    if (await getClient(clientID)) throw new Error(`Identity registration remains for ${app.appId}`);
  }
  if (app.forwardAuthEnabled && app.subdomain && app.domain) {
    await removeForwardAuth({ hostname: `${app.subdomain}.${app.domain}` });
  }
  if (app.subdomain && app.domain) {
    const { getCNAMERecords, getDNSRecords, removeCNAMERecord, removeDNSRecord } = await import('../apps/pihole-api');
    const hostname = `${app.subdomain}.${app.domain}`;
    for (const record of await getCNAMERecords()) {
      if (record.domain === hostname) await removeCNAMERecord(record.domain, record.target);
    }
    for (const record of await getDNSRecords()) {
      if (record.domain === hostname) await removeDNSRecord(record.ip, record.domain);
    }
    const [cnames, records] = await Promise.all([getCNAMERecords(), getDNSRecords()]);
    if (cnames.some(record => record.domain === hostname) || records.some(record => record.domain === hostname)) {
      throw new Error(`Network registration remains for ${app.appId}`);
    }
  }
}

async function startContainerAfterRestore(container: string): Promise<void> {
  for (let attempt = 1; attempt <= RESTORE_CONTAINER_START_ATTEMPTS; attempt++) {
    try {
      await incusRequest('PUT', `/1.0/instances/${encodeURIComponent(container)}/state`, {
        action: 'start',
        timeout: 60,
      });
    } catch {
      // Incus can reject a start briefly while the old monitor cgroup drains.
    }

    if ((await runningContainers([container])).includes(container)) return;
    if (attempt < RESTORE_CONTAINER_START_ATTEMPTS) {
      await new Promise(resolve => setTimeout(resolve, RESTORE_CONTAINER_START_DELAY_MS));
    }
  }
  throw new Error(`Core service did not restart after volume restore: ${container}`);
}

/**
 * Restore the full YouEye platform from a backup directory.
 *
 * The backupPath should point to the root of the backup directory
 * which contains a `youeye/` subdirectory with `core/` and `apps/` folders.
 */
export async function fullRestore(
  config: FullRestoreConfig,
  onEvent: BackupEventCallback
): Promise<void> {
  const { backupPath, passphrase } = config;
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const stagingDir = path.join(STAGING_BASE, `full-${timestamp}`);

  // Discover available backup archives
  const coreDir = path.join(backupPath, 'youeye', 'core');
  const appsDir = path.join(backupPath, 'youeye', 'apps');

  // Find the latest core backup
  let coreArchive: string | null = config.coreArchivePath || null;
  if (!coreArchive && existsSync(coreDir)) {
    const files = readdirSync(coreDir)
      .filter(f => f.startsWith('core-') && f.endsWith('.tar.enc'))
      .sort()
      .reverse();
    if (files.length > 0) {
      coreArchive = path.join(coreDir, files[0]);
    }
  }

  // Discover per-app backup archives
  let appArchives: Array<{ appId: string; archivePath: string }> = [];
  if (existsSync(appsDir)) {
    const appDirs = readdirSync(appsDir);
    for (const appId of appDirs) {
      const appDir = path.join(appsDir, appId);
      try {
        const files = readdirSync(appDir)
          .filter(f => f.endsWith('.tar.enc'))
          .sort()
          .reverse();
        if (files.length > 0) {
          appArchives.push({ appId, archivePath: path.join(appDir, files[0]) });
        }
      } catch {
        // Skip unreadable directories
      }
    }
  }

  if (config.appIds !== undefined) {
    if (new Set(config.appIds).size !== config.appIds.length || config.appIds.some(appId => !/^[a-z0-9][a-z0-9-]{0,62}$/.test(appId))) {
      throw new Error('Restore selection contains an invalid app identifier.');
    }
    const available = new Set(appArchives.map(item => item.appId));
    const missing = config.appIds.filter(appId => !available.has(appId));
    if (missing.length > 0) throw new Error(`Selected app backup is unavailable: ${missing.join(', ')}`);
    const selected = new Set(config.appIds);
    appArchives = appArchives.filter(item => selected.has(item.appId));
  }

  // Calculate total steps
  const totalSteps = (coreArchive ? 9 : 1) + appArchives.length;
  let step = 0;

  const emit = (stage: string, message: string, status: BackupEvent['status'] = 'progress') => {
    step++;
    onEvent({
      step,
      totalSteps,
      status,
      stage,
      message,
      progress: Math.round((step / totalSteps) * 100),
    });
  };

  try {
    await mkdir(stagingDir, { recursive: true });

    if (!coreArchive) {
      onEvent({
        step: 0,
        totalSteps,
        status: 'error',
        stage: 'discover',
        message: `No core backup found in ${coreDir}`,
      });
      throw new Error(`No core backup found in ${coreDir}`);
    }

    // ── Step 1: Decrypt + extract core backup ──────────────
    emit('decrypt-core', 'Decrypting core backup archive...');
    const coreStagingDir = path.join(stagingDir, 'core');
    await mkdir(coreStagingDir, { recursive: true });

    await spineClient.restoreArchive({
      archive_path: coreArchive,
      passphrase,
      staging_dir: coreStagingDir,
    });

    // Validate every mandatory core input before changing the live server.
    const coreMetaPath = path.join(coreStagingDir, 'backup-meta.json');
    const configPath = path.join(coreStagingDir, 'configs', 'youeye-config.json');
    const dbDir = path.join(coreStagingDir, 'databases');
    const caddyConfigPath = path.join(coreStagingDir, 'caddy', 'caddy-config.json');
    const piholePath = path.join(coreStagingDir, 'pihole', 'pihole.toml');
    const installedAppsPath = path.join(coreStagingDir, 'installed-apps.json');
    for (const required of [coreMetaPath, configPath, caddyConfigPath, piholePath, installedAppsPath]) {
      if (!existsSync(required)) throw new Error(`Core backup is missing required input: ${path.basename(required)}`);
    }
    const coreMeta = JSON.parse(await readFile(coreMetaPath, 'utf-8')) as Record<string, unknown>;
    if (coreMeta.schema !== 'youeye.backup.core-meta.v1' || coreMeta.type !== 'core') {
      throw new Error('Core backup has an unsupported compatibility record.');
    }
    const compatibility = assessBackupCompatibility(coreMeta.source, await readCurrentBackupSourceIdentity());
    if (!compatibility.compatible) throw new Error(compatibility.summary);
    const spineConfig = JSON.parse(await readFile(configPath, 'utf-8')) as Record<string, unknown>;
    const caddyConfig = JSON.parse(await readFile(caddyConfigPath, 'utf-8'));
    const piholeContent = await readFile(piholePath, 'utf-8');
    const restoredApps = parseRestoredAppInventory(JSON.parse(await readFile(installedAppsPath, 'utf-8')));
    if (!existsSync(dbDir)) throw new Error('Core backup is missing required database dumps');
    const dbFiles = readdirSync(dbDir).filter(file => file.endsWith('.sql'));
    const databasesInArchive = new Set(dbFiles.map(file => file.replace(/-\d{4}-\d{2}.*\.sql$/, '')));
    if (!Array.isArray(coreMeta.databases)
      || coreMeta.databases.some(database => typeof database !== 'string' || !isPlatformDatabase(database))
      || new Set(coreMeta.databases).size !== coreMeta.databases.length
      || coreMeta.databases.some(database => !databasesInArchive.has(String(database)))
      || [...databasesInArchive].some(database => !(coreMeta.databases as unknown[]).includes(database))) {
      throw new Error('Core backup database inventory does not match its authenticated contents.');
    }
    const missingDatabases = PLATFORM_DATABASES.filter(database => !databasesInArchive.has(database));
    if (missingDatabases.length > 0) throw new Error(`Core backup is missing required database dumps: ${missingDatabases.join(', ')}`);

    emit('remove-current-apps', 'Clearing current applications before server restore...');
    for (const currentApp of await listInstalledApps()) await removeCurrentApp(currentApp.appId);

    emit('restore-volumes', 'Restoring persistent server configuration...');
    const machineConfig = config.setupMode ? await captureSetupMachineConfig() : [];
    if (config.setupMode) await prepareSetupRestoreVolumeMap(coreStagingDir);
    const quiesced = await runningContainers(config.setupMode
      ? ['youeye-pihole', 'youeye-pointer']
      : ['youeye-caddy', 'youeye-pihole', 'youeye-ui', 'youeye-pointer']);
    for (const container of quiesced) {
      await incusRequest('PUT', `/1.0/instances/${container}/state`, { action: 'stop', force: true, timeout: 60 });
    }
    let machineConfigRestoreError: unknown;
    try {
      await spineClient.applyBackupVolumes(coreStagingDir);
    } finally {
      if (config.setupMode) {
        try {
          await restoreSetupMachineConfig(machineConfig);
        } catch (error) {
          machineConfigRestoreError = error;
        }
      }
      const restartFailures: string[] = [];
      for (const container of quiesced) {
        try {
          await startContainerAfterRestore(container);
        } catch {
          restartFailures.push(container);
        }
      }
      if (restartFailures.length > 0) {
        throw new Error(`Core services did not restart after volume restore: ${restartFailures.join(', ')}`);
      }
      if (machineConfigRestoreError) {
        throw new Error(`Target runtime credentials could not be preserved: ${machineConfigRestoreError}`);
      }
    }
    if (quiesced.length > 0) await new Promise(resolve => setTimeout(resolve, 3000));

    // ── Step 2: Restore youeye.yaml config ─────────────────
    emit('restore-config', 'Restoring platform configuration...');
    try {
      await spineClient.setConfig(config.setupMode ? { ...spineConfig, setup_completed: false } : spineConfig);
    } catch (err) {
      throw new Error(`Could not restore the server configuration: ${err}`);
    }

    // ── Step 3: Restore PostgreSQL databases ───────────────
    emit('restore-databases', 'Restoring infrastructure databases...');
	const restoredDatabases = new Set<string>();
    for (const dbFile of dbFiles) {
      // Extract database name from filename pattern: {dbName}-{timestamp}.sql
      const dbName = dbFile.replace(/-\d{4}-\d{2}.*\.sql$/, '');
      if (!isPlatformDatabase(dbName)) {
        throw new Error('Core backup contains an unexpected database dump');
      }

      try {
        const dump = await readFile(path.join(dbDir, dbFile));
        await replacePlatformDatabase(dbName, dump);
		restoredDatabases.add(dbName);
      } catch (err) {
        onEvent({
          step,
          totalSteps,
          status: 'error',
          stage: 'restore-databases',
          message: `Failed to restore ${dbName}: ${err}`,
        });
        throw new Error(`Failed to restore ${dbName}: ${err}`);
      }
    }
	const databasesNotRestored = PLATFORM_DATABASES.filter(database => !restoredDatabases.has(database));
	if (databasesNotRestored.length > 0) throw new Error(`Core backup is missing required database dumps: ${databasesNotRestored.join(', ')}`);

    // ── Step 5: Restore Caddy config ───────────────────────
    emit('restore-caddy', config.setupMode
      ? 'Rebuilding service connections for this server...'
      : 'Restoring Caddy configuration...');
    try {
      if (config.setupMode) await reconcileSetupRuntime(spineConfig);
      else await setCaddyConfig(caddyConfig);
    } catch (err) {
      throw new Error(`Could not restore the server routing configuration: ${err}`);
    }

    // ── Step 6: Restore Pi-Hole config ─────────────────────
    emit('restore-pihole', 'Restoring Pi-Hole configuration...');
    try {
      await incusUploadFile(
        'youeye-pihole',
        '/etc/pihole/pihole.toml',
        Buffer.from(piholeContent, 'utf8'),
        { timeout: 10_000, mode: '0600' },
      );
      const reload = await execCommand('youeye-pihole', ['pihole', 'reloaddns'], { timeout: 15_000 });
      if (reload.exitCode !== 0) throw new Error('Pi-hole DNS reload failed');
      if (config.setupMode && typeof spineConfig.domain === 'string') {
        const hostIP = (await spineClient.getMetrics()).primary_ip.trim();
        await setDomainDNS(spineConfig.domain, hostIP);
      }
    } catch (err) {
      throw new Error(`Could not restore the network shield configuration: ${err}`);
    }

    emit('reconcile-apps', 'Applying the selected application recovery plan...');
    for (const restoredApp of restoredApps) await clearRestoredAppRegistration(restoredApp);

    // ── Restore each selected app ──────────────────────────
    for (const { appId, archivePath } of appArchives) {
      emit('restore-app', `Restoring app: ${appId}...`);
      try {
        await restoreApp(
          { appId, archivePath, passphrase },
          (event) => {
            // Relay app restore events as sub-events
            onEvent({
              step,
              totalSteps,
              status: event.status === 'error' ? 'error' : 'progress',
              stage: `restore-app-${appId}`,
              message: `[${appId}] ${event.message}`,
              detail: event.detail,
            });
          },
          false,
        );
      } catch (err) {
        onEvent({
          step,
          totalSteps,
          status: 'error',
          stage: `restore-app-${appId}`,
          message: `Failed to restore ${appId}: ${err}`,
        });
        throw new Error(`Failed to restore ${appId}: ${err}`);
      }
    }

    // Final completion
    onEvent({
      step: totalSteps,
      totalSteps,
      status: 'completed',
      stage: 'completed',
      message: 'Full platform restore completed successfully',
      progress: 100,
    });
  } finally {
    // Clean up staging directory
    try {
      if (existsSync(stagingDir)) {
        await rm(stagingDir, { recursive: true, force: true });
      }
    } catch {
      // Best effort
    }
  }
}
