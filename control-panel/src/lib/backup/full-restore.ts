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
import { randomUUID } from 'node:crypto';
import { spineClient } from '@/lib/spine/client';
import { execCommand, incusRequest, incusUploadFile } from '@/lib/incus/server';
import {
  getRoutes,
  removeAppRoutes,
  removeRoute,
  setConfig as setCaddyConfig,
} from '@/lib/caddy/client';
import { withAppInventory, withAppLifecycles } from '@/lib/market/update-admission';
import { restoreApp } from './app-restore';
import { listInstalledApps, listRetainedApps, readInstallMetadata, saveInstallMetadata } from '@/lib/market/metadata';
import { uninstallApp, deregisterAppFromUI } from '@/lib/market/uninstaller';
import { getAdmissionPolicy } from '@/lib/admission/store';
import { identityRows, identitySql } from '@/lib/identity/store';
import { getInstalledApp, removeInstalledApp } from '@/lib/market/installed-apps';
import { isUuid } from '../../../../shared/admission';
import type { InstallMetadata } from '@/lib/market/types';
import { quiesceAppCredentialRuntime } from '@/lib/apps/service-credential-probe';
import { getClient } from '@/lib/identity/store';
import { removeForwardAuth, removeOAuthClient } from '@/lib/identity/provider';
import type {
  FullRestoreConfig,
  BackupEvent,
  BackupEventCallback,
} from './types';
import { BACKUP_STAGING_ROOT, runningContainers } from './workspace';
import { isPlatformDatabase, PLATFORM_DATABASES, replacePlatformDatabase, suspendRestoredAppCredentials } from './postgres';
import { assessBackupCompatibility, readCurrentBackupSourceIdentity } from './compatibility';
import * as caddy from '@/lib/caddy/client';
import { getDNSRecords, setDomainDNS, setIdentityHostDNS } from '@/lib/apps/pihole-api';
import { getIdentityConfig } from '@/lib/identity/config';
import {
  configureControlPanelIdentitySSO,
  configureUIIdentitySSO,
} from '@/lib/identity/core-clients';
import { tlsStorage } from '@/lib/acme/storage';
import { configurePointerForPlatform } from '@/lib/infrastructure/deployer';
import { readRetainedAppInventory, restoreRetainedApps } from './retained-apps';
import { markCredentialReady, reconcileRetainedAppCredential } from '@/lib/apps/service-credential-bridge';
import { operateAppCredential } from '@/lib/apps/service-credential-operations';
import { beginContainerMaintenance } from '@/lib/maintenance/container-maintenance';
import { appServiceCredentials } from '@/lib/apps/service-credential-store';

const STAGING_BASE = path.join(BACKUP_STAGING_ROOT, 'restore');
const RESTORE_CONTAINER_START_ATTEMPTS = 5;
const RESTORE_CONTAINER_START_DELAY_MS = 1500;
const RESTORED_PIHOLE_READY_ATTEMPTS = 20;
const RESTORED_PIHOLE_READY_DELAY_MS = 1000;
const CORE_VOLUME_MAP_SCHEMA = 'youeye.backup.volume-map.v1';
const SETUP_RESTORABLE_CORE_VOLUMES = new Set([
  '/var/lib/youeye/config',
  '/var/lib/youeye/pihole',
  '/var/lib/youeye/pointer',
  '/var/lib/youeye/ui-data',
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
  '/var/lib/youeye/ui-data',
]);

interface RestoredAppInventory {
  appId: string;
  installationId: string;
  containers: string[];
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

async function prepareSetupRestoreVolumeMap(coreStagingDir: string, retainedApps: InstallMetadata[] = []): Promise<void> {
  const volumeMapPath = path.join(coreStagingDir, 'volume-map.json');
  const document = JSON.parse(await readFile(volumeMapPath, 'utf8')) as {
    schema?: unknown;
    volumes?: unknown;
  };
  if (document.schema !== CORE_VOLUME_MAP_SCHEMA || !Array.isArray(document.volumes)) {
    throw new Error('Core backup contains an invalid volume map');
  }

  const volumes = document.volumes as CoreVolumeMapping[];
  const retainedPaths = new Set(retainedApps.map(app => `/var/lib/youeye/app-${app.appId}`));
  for (const mapping of volumes) {
    const source = typeof mapping?.source === 'string'
      ? path.posix.normalize(mapping.source.replace(/\/$/, ''))
      : '';
    if (!source || typeof mapping?.archive_path !== 'string'
      || (!KNOWN_CORE_VOLUMES.has(source) && !retainedPaths.has(source))) {
      throw new Error('Core backup contains an unsupported setup volume');
    }
    mapping.source = source;
  }

  // A fresh appliance owns its generated runtime wiring. Importing the old
  // Caddy state, network leases, or UI database endpoint can disconnect the
  // setup browser and point services at the source appliance. Restore only
  // portable persistent state; the structured config/database records below
  // rebuild the target-specific service bindings.
  const portable = volumes.filter(mapping => SETUP_RESTORABLE_CORE_VOLUMES.has(mapping.source) || retainedPaths.has(mapping.source));
  await writeFile(
    volumeMapPath,
    `${JSON.stringify({ schema: CORE_VOLUME_MAP_SCHEMA, volumes: portable }, null, 2)}\n`,
    { mode: 0o600 },
  );
}

async function preserveRetainedAppNetworks(coreStagingDir: string): Promise<void> {
  const filename = path.join(coreStagingDir, 'volume-map.json');
  const document = JSON.parse(await readFile(filename, 'utf8'));
  if (document.schema !== CORE_VOLUME_MAP_SCHEMA || !Array.isArray(document.volumes)) {
    throw new Error('Core backup contains an invalid volume map');
  }
  document.volumes = document.volumes.filter((mapping: CoreVolumeMapping) =>
    path.posix.normalize(mapping.source) !== '/var/lib/youeye/networks');
  await writeFile(filename, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
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
  await replaceSetupContainerRoute(domain, 'youeye-ui', 3000, uiSubdomain);
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
  await caddy.reconcileManagedRoutes(domain);
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
    if (!isUuid(item.installationId) || !Array.isArray(item.containers) || item.containers.length > 100
      || item.containers.some(container => !container || typeof container !== 'object'
        || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(container.containerName))) {
      throw new Error('Core backup is missing immutable installed-runtime ownership');
    }
    seen.add(item.appId);
    result.push({
      appId: item.appId,
      installationId: item.installationId,
      containers: item.containers.map(container => container.containerName),
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
  const policy = await getAdmissionPolicy(app.appId);
  if (!policy || policy.installationId !== app.installationId) {
    throw new Error('Restored registration has unknown installation ownership');
  }
  if (await readInstallMetadata(app.appId)) {
    // A restored registration is not authority to discard a live runtime.
    throw new Error('Restored registration still has live installation metadata');
  }
  for (const name of app.containers) {
    const runtime = await incusRequest('GET', `/1.0/instances/${encodeURIComponent(name)}`);
    if (runtime.type !== 'error' || runtime.error_code !== 404) {
      throw new Error('Restored registration cleanup refuses an existing or unverified runtime');
    }
  }
  const clientID = app.ssoClientId || app.ssoSlug || (app.enableSSO ? `youeye-app-${app.appId}` : '');
  if (clientID) {
    const [binding] = await identityRows<{ installation_id: string }>(`SELECT installation_id::text
      FROM admission_clients WHERE client_id = ${identitySql(clientID)}`);
    if (binding?.installation_id !== app.installationId) throw new Error('Restored client has foreign ownership');
  }
  const hostname = app.subdomain && app.domain ? `${app.subdomain}.${app.domain}` : '';
  if (hostname) {
    const [binding] = await identityRows<{ installation_id: string }>(`SELECT installation_id::text
      FROM admission_routes WHERE host = ${identitySql(hostname.toLowerCase())} AND path_prefix = '/'`);
    if (binding?.installation_id !== app.installationId) throw new Error('Restored route has foreign ownership');
  }
  await removeInstalledApp(app.appId);
  if (await getInstalledApp(app.appId)) throw new Error('Restored installed-app registration remains');
  await deregisterAppFromUI(app.appId, true);
  const { isAppRegisteredWithUI } = await import('@/lib/market/reconciler');
  if (await isAppRegisteredWithUI(app.appId)) throw new Error('Restored dashboard registration remains');

  // The core archive owns Caddy's complete configuration, but app install
  // metadata lives with each app archive. After current apps are removed the
  // restored primary route can therefore have a generic `route-*` identifier
  // with no live install metadata for uninstallApp() to associate with the
  // app. Remove it using the independently validated core inventory before
  // the selected app's manifest-driven reinstall runs its collision preflight.
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

async function waitForRestoredPiholeAPI(): Promise<void> {
  // Applying Pi-hole's restored DNS settings can restart FTL after the config
  // call returns. App cleanup uses its authenticated API immediately afterward.
  // Require two spaced reads so a short-lived listener is not treated as ready.
  let consecutive = 0;
  let lastError: unknown;
  for (let attempt = 0; attempt < RESTORED_PIHOLE_READY_ATTEMPTS; attempt += 1) {
    try {
      await getDNSRecords();
      consecutive += 1;
      if (consecutive === 2) return;
    } catch (error) {
      consecutive = 0;
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, RESTORED_PIHOLE_READY_DELAY_MS));
  }
  throw new Error(`Pi-hole API did not become ready after restoring DNS: ${lastError ?? 'readiness did not stabilize'}`);
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
  const appDirectory = path.join(config.backupPath, 'youeye', 'apps');
  const archivedIds = config.appIds ?? (existsSync(appDirectory) ? readdirSync(appDirectory) : []);
  return withAppInventory(async () => {
    const current = await listInstalledApps();
    return withAppLifecycles(['identity', 'pointer', ...current.map(app => app.appId), ...archivedIds],
      () => fullRestoreUnderLifecycle(config, onEvent));
  });
}

async function fullRestoreUnderLifecycle(config: FullRestoreConfig, onEvent: BackupEventCallback): Promise<void> {
  const { backupPath, passphrase } = config;
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const stagingDir = path.join(STAGING_BASE, `full-${timestamp}-${randomUUID()}`);
  const retainedLeases: ReturnType<typeof beginContainerMaintenance>[] = [];
  let retainedApps: InstallMetadata[] = [];
  const preparedRetainedApps: InstallMetadata[] = [];

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
    const archivedRetainedApps = await readRetainedAppInventory(coreStagingDir);
    for (const required of [coreMetaPath, configPath, caddyConfigPath, piholePath, installedAppsPath]) {
      if (!existsSync(required)) throw new Error(`Core backup is missing required input: ${path.basename(required)}`);
    }
    const coreMeta = JSON.parse(await readFile(coreMetaPath, 'utf-8')) as Record<string, unknown>;
    if (coreMeta.schema !== 'youeye.backup.core-meta.v1' || coreMeta.type !== 'core') {
      throw new Error('Core backup has an unsupported compatibility record.');
    }
    if (coreMeta.admissionSchemaVersion !== 1) throw new Error('Core backup is missing supported identity/ownership metadata');
    if (coreMeta.retainedDataSchemaVersion !== undefined && coreMeta.retainedDataSchemaVersion !== 1) {
      throw new Error('Core backup has unsupported retained-data metadata');
    }
    const compatibility = assessBackupCompatibility(coreMeta.source, await readCurrentBackupSourceIdentity());
    if (!compatibility.compatible) throw new Error(compatibility.summary);
    const spineConfig = JSON.parse(await readFile(configPath, 'utf-8')) as Record<string, unknown>;
    const caddyConfig = JSON.parse(await readFile(caddyConfigPath, 'utf-8'));
    const piholeContent = await readFile(piholePath, 'utf-8');
    const restoredApps = parseRestoredAppInventory(JSON.parse(await readFile(installedAppsPath, 'utf-8')));
    if (archivedRetainedApps.some(retained => restoredApps.some(app => app.appId === retained.appId))) {
      throw new Error('Core backup has conflicting active and retained app inventories');
    }
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

    if ((await listRetainedApps()).length) {
      throw new Error('This target has retained app data; explicitly resolve it before a historical server restore');
    }
    const currentApps = await listInstalledApps();
    const selectedApps = new Set(appArchives.map(app => app.appId));
    // An explicit selection restores those archives and retains other installed
    // apps. A fresh/setup restore or whole-server restore replaces the inventory.
    retainedApps = config.appIds !== undefined && !config.setupMode
      ? currentApps.filter(app => !selectedApps.has(app.appId)) : [];
    const retainedIds = new Set(retainedApps.map(app => app.appId));
    for (const app of retainedApps) {
      const archived = restoredApps.find(item => item.appId === app.appId);
      // A core from another routing/identity installation cannot safely adopt
      // these runtimes. Reject before changing data; include their app archives.
      if (!archived || archived.installationId !== app.installationId || archived.domain !== app.domain || archived.subdomain !== app.subdomain
        || archived.ssoClientId !== app.ssoClientId || archived.ssoSlug !== app.ssoSlug) {
        throw new Error(`Retained ${app.appId} requires a matching core identity or its app archive`);
      }
    }
    emit('remove-current-apps', 'Preparing applications for the selected server restore...');
    for (const app of retainedApps) {
      const names = app.containers.map(container => typeof container === 'string' ? container : container.containerName);
      retainedLeases.push(beginContainerMaintenance(names, { operation: `core-restore:${app.appId}` }));
      preparedRetainedApps.push(app);
      app.serviceCredentialDesiredState ??= app.desiredState ?? 'running';
      app.serviceCredentialState = 'pending';
      app.enabled = false;
      app.desiredState = 'stopped';
      await saveInstallMetadata(app);
      await quiesceAppCredentialRuntime(names);
      if ((await appServiceCredentials.projection(app.appId))?.status === 'active') {
        await markCredentialReady(app.appId, false);
      }
    }
    for (const currentApp of currentApps) {
      if (!retainedIds.has(currentApp.appId)) await removeCurrentApp(currentApp.appId);
    }

    emit('restore-volumes', 'Restoring persistent server configuration...');
    const machineConfig = config.setupMode ? await captureSetupMachineConfig() : [];
    if (config.setupMode) await prepareSetupRestoreVolumeMap(coreStagingDir, archivedRetainedApps);
    if (retainedApps.length) await preserveRetainedAppNetworks(coreStagingDir);
    const quiesced = await runningContainers(config.setupMode
      ? ['youeye-pihole', 'youeye-pointer', 'youeye-ui']
      : ['youeye-caddy', 'youeye-pihole', 'youeye-ui', 'youeye-pointer']);
    await quiesceAppCredentialRuntime(quiesced);
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
      if (machineConfigRestoreError) {
        throw new Error(`Target runtime credentials could not be preserved: ${machineConfigRestoreError}`);
      }
    }

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
    for (const dbFile of [...dbFiles].sort((a, b) =>
      Number(!a.startsWith('youeye-')) - Number(!b.startsWith('youeye-')))) {
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
    const { identityCommand, refreshIdentitySchemaAfterRestore } = await import('@/lib/identity/store');
    // The restored snapshot can predate additive ownership/queue migrations.
    // Do not trust this surviving process's pre-restore schema-ready cache.
    await refreshIdentitySchemaAfterRestore(path.basename(stagingDir));
    // No restored projection is active until a fresh authenticated push.
    await identityCommand(`UPDATE admission_outbox SET acknowledged_revision = 0`);
    await restoreRetainedApps(coreStagingDir, archivedRetainedApps);
    await suspendRestoredAppCredentials();
    // Keep UI and ordinary ingress stopped until identity, ownership and UI
    // databases are coherent. A failed database restore remains closed.
    const restartFailures: string[] = [];
    for (const container of quiesced) {
      try { await startContainerAfterRestore(container); }
      catch { restartFailures.push(container); }
    }
    if (restartFailures.length) {
      throw new Error(`Core services did not restart after identity restore: ${restartFailures.join(', ')}`);
    }
    if (quiesced.length > 0) await new Promise(resolve => setTimeout(resolve, 3000));
	// The issuer pin lives in the portable youeye database. Never derive a route
	// from the fresh target's pre-restore database or mutable setup hostname.
	const restoredIdentity = config.setupMode ? await getIdentityConfig() : null;

    // ── Step 5: Restore Caddy config ───────────────────────
    emit('restore-caddy', config.setupMode
      ? 'Rebuilding service connections for this server...'
      : 'Restoring Caddy configuration...');
    try {
      if (config.setupMode) {
        await reconcileSetupRuntime(spineConfig);
        if (restoredIdentity) await caddy.ensureIdentityRoute(new URL(restoredIdentity.issuer).hostname, restoredIdentity.containerName, restoredIdentity.port);
      }
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
        await waitForRestoredPiholeAPI();
        const identity = await getIdentityConfig();
        const canonicalHost = new URL(identity.issuer).hostname;
        const configuredHost = `${String((spineConfig.subdomains as Record<string, string> | undefined)?.identity || 'id')}.${spineConfig.domain}`;
        if (canonicalHost !== configuredHost) await setIdentityHostDNS(canonicalHost, hostIP);
      }
      await waitForRestoredPiholeAPI();
    } catch (err) {
      throw new Error(`Could not restore the network shield configuration: ${err}`);
    }

    emit('reconcile-apps', 'Applying the selected application recovery plan...');
    for (const restoredApp of restoredApps) {
      if (!retainedIds.has(restoredApp.appId)) await clearRestoredAppRegistration(restoredApp);
    }
    for (const app of retainedApps) {
      // Install metadata and protected authority are target-owned, outside core
      // volume restore. Never replace them with archived verifier hashes.
      await saveInstallMetadata(app);
      const state = await reconcileRetainedAppCredential(app.appId);
      if (state === 'revoked') {
        app.serviceCredentialState = 'revoked';
        await saveInstallMetadata(app);
      } else {
        await operateAppCredential(app.appId, { action: 'reconcile' });
      }
    }

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
  } catch (error) {
    // A later app failure must not leave an earlier retained app reopened.
    // Persist pending intent and stop writers before releasing watchdog leases.
    for (const lease of retainedLeases) lease.markFailed('Server restore requires reconciliation');
    let cleanupFailed = false;
    for (const app of preparedRetainedApps) {
      app.serviceCredentialState = 'pending';
      app.enabled = false;
      app.desiredState = 'stopped';
      try {
        try { await saveInstallMetadata(app); } finally {
          await quiesceAppCredentialRuntime(app.containers.map(container =>
            typeof container === 'string' ? container : container.containerName));
        }
        if ((await appServiceCredentials.projection(app.appId))?.status === 'active') {
          await markCredentialReady(app.appId, false);
        }
      } catch { cleanupFailed = true; }
    }
    if (cleanupFailed) throw new Error('Server restore failed; retained app maintenance requires reconciliation');
    throw error;
  } finally {
    for (const lease of retainedLeases) lease.release();
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
