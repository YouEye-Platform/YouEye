/**
 * Full platform restore orchestrator.
 *
 * Restores the entire YouEye platform from a backup:
 * 1. Decrypt + extract core backup
 * 2. Restore youeye.yaml config
 * 3. Restore infrastructure secrets
 * 4. Restore the YouEye database (including YouEye ID)
 * 5. Restore Caddy and Pi-Hole configuration
 * 6. Restore the Market's sources and Added apps (when the backup carries them)
 * 7. For each app archive: restoreApp()
 */

import { chmod, readFile, mkdir, rm, writeFile } from 'fs/promises';
import { existsSync, readdirSync, readFileSync } from 'fs';
import path from 'path';
import { randomUUID } from 'node:crypto';
import { spineClient } from '@/lib/spine/client';
import { execCommand, incusRequest, incusUploadFile } from '@/lib/incus/server';
import {
  getRoutes,
  removeRoute,
  setConfig as setCaddyConfig,
} from '@/lib/caddy/client';
import { withAppInventory, withAppLifecycles } from '@/lib/market/update-admission';
import { logOperationFailure } from '@/lib/market/install-tracker';
import { restoreApp } from './app-restore';
import { listInstalledApps, listRetainedApps, readInstallMetadata, saveInstallMetadata } from '@/lib/market/metadata';
import { uninstallApp, deregisterAppFromUI } from '@/lib/market/uninstaller';
import { getAdmissionPolicy } from '@/lib/admission/store';
import { identityRows, identitySql } from '@/lib/identity/store';
import { getInstalledApp, removeInstalledApp } from '@/lib/market/installed-apps';
import { isUuid } from '../../../../shared/admission';
import type { InstallMetadata } from '@/lib/market/types';
import { quiesceAppCredentialRuntime } from '@/lib/apps/service-credential-probe';
import { ensureClient, getClient, type IdentityClient } from '@/lib/identity/store';
import { removeForwardAuth, removeOAuthClient } from '@/lib/identity/provider';
import type {
  BackupEncryption,
  FullRestoreConfig,
  FullRestoreProgress,
  BackupEvent,
  BackupEventCallback,
} from './types';
import { BACKUP_STAGING_ROOT, runningContainers } from './workspace';
import {
  isPlatformDatabase, listRestoredAppCredentialIds, PLATFORM_DATABASES, replacePlatformDatabase, suspendRestoredAppCredentials,
} from './postgres';
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
import { fenceAbsentAppCredential, markCredentialReady, reconcileRetainedAppCredential } from '@/lib/apps/service-credential-bridge';
import { operateAppCredential } from '@/lib/apps/service-credential-operations';
import {
  beginContainerMaintenance, holdContainersForOperation, type ContainerMaintenanceLease,
} from '@/lib/maintenance/container-maintenance';
import { releaseAbsentAppNetwork } from '@/lib/incus/app-network';
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
const APP_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** The core services a restore on a box in use stops while it replaces their data (setup leaves Caddy serving). */
const IN_PLACE_CORE_SERVICES = ['youeye-caddy', 'youeye-pihole', 'youeye-ui', 'youeye-pointer'];
const SETUP_CORE_SERVICES = ['youeye-pihole', 'youeye-pointer', 'youeye-ui'];
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
      const contents = await readFile(filePath);
      if (filePath === SETUP_PRESERVED_MACHINE_CONFIG[0] && contents.length === 0) {
        throw new Error('Target runtime credential is empty');
      }
      return { path: filePath, contents };
    } catch (error) {
      // Only an absent optional config may be removed after applying the
      // source volume. An unreadable file is still target-owned state, and
      // the credential is mandatory for exact-target recovery.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT'
        && filePath !== SETUP_PRESERVED_MACHINE_CONFIG[0]) {
        return { path: filePath, contents: null };
      }
      throw new Error('Target runtime configuration could not be captured before restore', { cause: error });
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

/**
 * A restore on a box in use never applies the backup's `/var/lib/youeye/networks`.
 *
 * That directory is the allocator of the app networks (`ipam.json`: which app owns which `yeapp<N>` bridge and
 * subnet). It describes the bridges that exist on this box now, not the ones that existed when the backup was
 * made: the apps that stay keep their bridges, and the removal of every other app has released its lease. The
 * backup's copy would name every app of the backup as the owner of a bridge that no longer exists, and the
 * reinstall of a restored app (which allocates its network like any install: the lowest free bridge and subnet)
 * refuses an app that already owns one. Nothing else in a backup refers to a bridge or a subnet.
 */
async function keepTargetAppNetworks(coreStagingDir: string): Promise<void> {
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

/** The YouEye ID client names an installed app can have (one in practice: `youeye-app-<id>`). */
function appClientIds(app: Pick<InstallMetadata, 'appId' | 'ssoClientId' | 'ssoSlug' | 'enableSSO'>): string[] {
  return [...new Set([app.ssoClientId, app.ssoSlug, app.enableSSO ? `youeye-app-${app.appId}` : undefined]
    .filter((clientId): clientId is string => Boolean(clientId)))];
}

/**
 * A kept app's YouEye ID client must stay the box's own through a server restore.
 *
 * The clients are rows of the `youeye` database, which the restore replaces with the backup's. A kept app is not
 * reinstalled, so it still holds the client secret it was given last, in its environment or its own settings. When
 * the client was made again after the backup (an app-only restore, a reinstall that kept the installation, sign-in
 * turned off and on), the backup's row has an older secret and YouEye ID refuses the app's token requests: nobody
 * can sign in to it. So the whole row (secret, redirect addresses, scopes, role claim) is read before the databases
 * are replaced and written back after. Nothing changes inside the app and no setup file runs.
 *
 * Sign-in through forward-auth has no client and no secret, so there is nothing to keep. A restored app is
 * reinstalled and gets a new client, which its `setup/sso.yaml` writes into it.
 */
async function readKeptAppClients(apps: InstallMetadata[]): Promise<IdentityClient[]> {
  const clients: IdentityClient[] = [];
  for (const clientId of apps.flatMap(appClientIds)) {
    const client = await getClient(clientId);
    if (client) clients.push(client);
  }
  return clients;
}

async function writeKeptAppClients(clients: IdentityClient[], apps: InstallMetadata[]): Promise<void> {
  const kept = new Set(apps.flatMap(appClientIds));
  for (const client of clients) {
    if (!kept.has(client.client_id)) continue;
    await ensureClient({
      clientId: client.client_id, clientSecret: client.client_secret, name: client.name,
      redirectUris: client.redirect_uris, postLogoutRedirectUris: client.post_logout_redirect_uris,
      backchannelLogoutUri: client.backchannel_logout_uri, scopes: client.scopes, roleClaim: client.role_claim,
    });
    if ((await getClient(client.client_id))?.client_secret !== client.client_secret) {
      throw new Error(`The YouEye ID client of a kept app did not come back: ${client.client_id}`);
    }
  }
}

/**
 * A server restore clears an app the backup does not keep with delete-data. It stops (nothing of the app deleted) on
 * an app whose keep-data removal started but did not finish: kept data is never deleted this way (YE-222); the owner
 * finishes that removal (`youeye app remove <id> --keep-data`) and restores again.
 */
async function removeCurrentApp(appId: string): Promise<void> {
  let result;
  try {
    result = await uninstallApp(appId, { keepData: false });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not clear the current ${appId} installation before server restore: ${reason}`);
  }
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
  // Exact hostname only: another app's routes (e.g. `foo-bar` for `foo`) are never matched.
  for (const route of await getRoutes()) {
    if (hostname && route.hostname === hostname) {
      await removeRoute(route.id);
    }
  }
  const remainingRoutes = await getRoutes();
  if (remainingRoutes.some(route => hostname && route.hostname === hostname)) {
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
  // The app has no install record and no container (checked above), so a network it still owns is a leftover;
  // the reinstall allocates its own.
  await releaseAbsentAppNetwork(app.appId);
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
 * The encryption the set records (backup-set.json `encryption`), passed to Spine with each of its archives. A set
 * without a record, or whose record has no `encryption` (made before 0.6.15), gives undefined, and Spine uses the
 * parameters of that time. A record that is there but cannot be read or parsed is refused: reading it as an older
 * set would decrypt a 0.6.15 set with the wrong parameters, which fails as "wrong passphrase".
 */
export function readBackupEncryption(backupPath: string): BackupEncryption | undefined {
  const file = path.join(backupPath, 'backup-set.json');
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(`The backup set's record (backup-set.json) cannot be read: ${(error as NodeJS.ErrnoException).code ?? 'read error'}.`);
  }
  let record: { encryption?: unknown };
  try {
    record = JSON.parse(text) as { encryption?: unknown };
  } catch {
    throw new Error('The backup set\'s record (backup-set.json) is damaged: it is not valid JSON.');
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error('The backup set\'s record (backup-set.json) is damaged: it is not a JSON object.');
  }
  const value = record.encryption as Partial<BackupEncryption> | undefined;
  if (value === undefined) return undefined;
  if (!value || typeof value.cipher !== 'string' || typeof value.kdf !== 'string' || typeof value.digest !== 'string'
    || typeof value.iterations !== 'number' || (value.mac !== undefined && typeof value.mac !== 'string')) {
    throw new Error('The backup set records its encryption in a form this server cannot read.');
  }
  return { cipher: value.cipher, kdf: value.kdf, digest: value.digest, iterations: value.iterations,
    ...(value.mac !== undefined ? { mac: value.mac } : {}) };
}

function readSkippedApps(backupPath: string): string[] {
  try {
    const record = JSON.parse(readFileSync(path.join(backupPath, 'backup-set.json'), 'utf8')) as { skippedApps?: Array<{ appId?: unknown }> };
    return (record.skippedApps ?? []).map(item => item.appId).filter((appId): appId is string => typeof appId === 'string');
  } catch {
    return [];
  }
}

/**
 * Keep the watchdog and the health monitor away from the core services a server restore stops, until the returned
 * release is called. `fullRestore` holds them itself; the restore route holds them as well, so the hold has no
 * gap between a failed restore and its rollback.
 */
export function holdRestoreServices(): () => void {
  return holdContainersForOperation(IN_PLACE_CORE_SERVICES);
}

const ROLLBACK_ATTEMPTS = 2;

/**
 * Roll a failed restore back from the pre-restore backup (rollbackRestoreConfig), and try once more when the
 * rollback itself fails: it is a restore like any other, and can be run again from where it stopped. The second
 * attempt starts the services either attempt left stopped and writes back the same YouEye ID clients.
 *
 * Returns 'unchanged' when the failed restore had changed nothing. Throws when every attempt failed, with each
 * attempt's own error (also logged with its cause).
 */
export async function rollBackRestore(
  failed: Pick<FullRestoreConfig, 'passphrase' | 'appIds'> & { progress: FullRestoreProgress },
  preRestore: { backupPath: string; apps: string[] },
  onEvent: BackupEventCallback,
  run: (config: FullRestoreConfig) => Promise<void> = config => fullRestore(config, onEvent),
): Promise<'unchanged' | 'recovered'> {
  let state = failed.progress;
  const errors: string[] = [];
  for (let attempt = 1; attempt <= ROLLBACK_ATTEMPTS; attempt++) {
    const config = rollbackRestoreConfig({ ...failed, progress: state }, preRestore);
    if (!config) return 'unchanged';
    const progress: FullRestoreProgress = { changed: false, stoppedServices: [] };
    try {
      await run({ ...config, progress });
      return 'recovered';
    } catch (error) {
      logOperationFailure(`Rollback of the server restore (attempt ${attempt} of ${ROLLBACK_ATTEMPTS})`, error);
      const message = error instanceof Error ? error.message : String(error);
      if (!errors.includes(message)) errors.push(message);
      state = {
        changed: true,
        stoppedServices: [...new Set([...state.stoppedServices, ...progress.stoppedServices])].sort(),
        keptAppClients: state.keptAppClients ?? progress.keptAppClients,
      };
    }
  }
  throw new Error(errors.join('; then: '));
}

/**
 * The restore that puts a box back after `failed` (a restore on a box in use) did not finish, from the pre-restore
 * backup made just before it. Null when the failed restore was refused before it changed anything.
 *
 * It is a restore of the same kind, so it keeps the same promise: the apps the failed restore was not replacing
 * stay installed and are never removed. Only the apps it was replacing come back from the pre-restore backup, an
 * app it added that the box did not have is removed, and the core services it left stopped are started again.
 */
export function rollbackRestoreConfig(
  failed: Pick<FullRestoreConfig, 'passphrase' | 'appIds'> & { progress: FullRestoreProgress },
  preRestore: { backupPath: string; apps: string[] },
): FullRestoreConfig | null {
  if (!failed.progress.changed) return null;
  const before = new Set(preRestore.apps);
  return {
    backupPath: preRestore.backupPath,
    passphrase: failed.passphrase,
    appIds: failed.appIds.filter(appId => before.has(appId)),
    discardAppIds: failed.appIds.filter(appId => !before.has(appId)),
    stoppedServices: [...failed.progress.stoppedServices],
    keptAppClients: failed.progress.keptAppClients,
  };
}

/**
 * Restore apps from a backup set without the core (`restoreCore: false`), each with its own rollback point.
 *
 * An app that cannot be restored does not cost the apps after it: the others are still restored, and the call
 * fails at the end naming every app that did not come back, like a server restore.
 */
export async function restoreApps(
  config: Pick<FullRestoreConfig, 'backupPath' | 'passphrase' | 'appIds'>,
  onEvent: BackupEventCallback,
): Promise<void> {
  const failures: string[] = [];
  const restored: string[] = [];
  for (const appId of config.appIds) {
    try {
      if (!APP_ID.test(appId)) throw new Error('invalid app identifier');
      const appDirectory = path.join(config.backupPath, 'youeye', 'apps', appId);
      const archives = existsSync(appDirectory)
        ? readdirSync(appDirectory).filter(file => file.endsWith('.tar.enc')).sort().reverse() : [];
      if (!archives[0]) throw new Error(`No archive found for ${appId}`);
      await restoreApp({ appId, archivePath: path.join(appDirectory, archives[0]), passphrase: config.passphrase,
        encryption: readBackupEncryption(config.backupPath) }, onEvent);
      restored.push(appId);
    } catch (error) {
      failures.push(`Failed to restore ${appId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`${failures.join('; ')}${restored.length > 0 ? ` (restored: ${restored.join(', ')})` : ''}`);
  }
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
  if (config.setupRecovery && !config.setupMode) throw new Error('Setup recovery requires setup admission');
  const discardIds = config.discardAppIds ?? [];
  if (!Array.isArray(config.appIds) || new Set(config.appIds).size !== config.appIds.length
    || [...config.appIds, ...discardIds].some(appId => typeof appId !== 'string' || !APP_ID.test(appId))) {
    throw new Error('Restore selection contains an invalid app identifier.');
  }
  if (discardIds.some(appId => config.appIds.includes(appId))) {
    throw new Error('Restore selection names an app both to restore and to remove.');
  }
  if (config.progress) Object.assign(config.progress, { changed: false, stoppedServices: [], keptAppClients: undefined });
  return withAppInventory(async () => {
    const current = await listInstalledApps();
    // Refuse before anything changes, naming the app: a full restore replaces every app, so none may be mid-update,
    // and a set that skipped an installed app would otherwise remove it.
    const { isAppUpdateReserved } = await import('@/lib/market/update-admission');
    const recovering = current.filter(app => isAppUpdateReserved(app.appId)).map(app => app.appId);
    if (recovering.length) {
      throw new Error(`Full restore refused: ${recovering.join(', ')} has an unfinished app update. Run youeye app recover first.`);
    }
    const skipped = readSkippedApps(config.backupPath).filter(appId => current.some(app => app.appId === appId));
    if (skipped.length) {
      throw new Error(`Full restore refused: this backup does not contain ${skipped.join(', ')}, which is installed here; `
        + 'restoring it would remove them. Take a new backup, or restore apps individually.');
    }
    return withAppLifecycles(['identity', 'pointer', ...current.map(app => app.appId), ...config.appIds],
      () => fullRestoreUnderLifecycle(config, onEvent));
  });
}

async function fullRestoreUnderLifecycle(config: FullRestoreConfig, onEvent: BackupEventCallback): Promise<void> {
  const { backupPath, passphrase } = config;
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const stagingDir = path.join(STAGING_BASE, `full-${timestamp}-${randomUUID()}`);
  const retainedLeases = new Map<string, ContainerMaintenanceLease>();
  const progress: FullRestoreProgress = config.progress ?? { changed: false, stoppedServices: [] };
  const coreServices = config.setupMode ? SETUP_CORE_SERVICES : IN_PLACE_CORE_SERVICES;
  let retainedApps: InstallMetadata[] = [];
  const preparedRetainedApps: InstallMetadata[] = [];
  let releaseServices: () => void = () => undefined;
  const checkpoint = config.setupRecovery;
  const runStep = (name: string, retry: 'replace' | 'never', work: () => Promise<void>) =>
    checkpoint ? checkpoint.step(name, retry, work) : work();
  let quiesced: string[] = checkpoint?.quiesced() ?? [];
  // The UI is what checks an app's credential, and a retained app's is marked not ready there while the app is
  // stopped. A UI that a restore has stopped (this one, or the failed one this one rolls back) cannot be told and
  // need not be: nothing can use a credential meanwhile, and the UI only starts again after the restore-databases
  // step has marked every restored credential not ready.
  const uiStoppedByRestore = async () => [...quiesced, ...(config.stoppedServices ?? [])].includes('youeye-ui')
    && (await runningContainers(['youeye-ui'])).length === 0;

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

  const available = new Set(appArchives.map(item => item.appId));
  const missing = config.appIds.filter(appId => !available.has(appId));
  if (missing.length > 0) throw new Error(`Selected app backup is unavailable: ${missing.join(', ')}`);
  const selected = new Set(config.appIds);
  appArchives = appArchives.filter(item => selected.has(item.appId));

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
      encryption: readBackupEncryption(backupPath),
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
    // The Market's sources and Added apps (backups made before they were carried have no `marketFiles`: the target's
    // Market files are then left as they are).
    const marketState = coreMeta.marketFiles === undefined ? null
      : await (await import('./market-state')).readMarketStateFromBackup(coreStagingDir, coreMeta.marketFiles);

    // Once removal is durably complete, the historical database may already
    // have replaced the target inventory. Do not reinterpret that inventory as
    // new removal authority. Unfinished removal itself is never auto-replayed.
    if (!checkpoint?.completed('remove-current-apps') && (await listRetainedApps()).length) {
      throw new Error('This target has retained app data; explicitly resolve it before a historical server restore');
    }
    const currentApps = checkpoint?.completed('remove-current-apps') ? [] : await listInstalledApps();
    const selectedApps = new Set(appArchives.map(app => app.appId));
    // The selected archives replace their apps; every other installed app is retained: no failure of this
    // restore, and no rollback of it, removes an app that was not selected. Setup starts from an empty box.
    const discarded = new Set(config.discardAppIds ?? []);
    retainedApps = config.setupMode ? []
      : currentApps.filter(app => !selectedApps.has(app.appId) && !discarded.has(app.appId));
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
    // Everything above only read the backup and the box.
    if (config.checkOnly) return;
    // From here to the end, whatever the outcome, the core services are this restore's to stop and start: the
    // watchdog must not start one while its data is being replaced (holdContainersForOperation).
    releaseServices = holdContainersForOperation(coreServices);
    await runStep('remove-current-apps', 'never', async () => {
      emit('remove-current-apps', 'Preparing applications for the selected server restore...');
      // Read while the databases are still the box's own; the rollback of this restore gets the same list.
      progress.keptAppClients = config.keptAppClients ?? await readKeptAppClients(retainedApps);
      progress.changed = true;
      const serving = !(await uiStoppedByRestore());
      for (const app of retainedApps) {
        const names = app.containers.map(container => container.containerName);
        retainedLeases.set(app.appId, beginContainerMaintenance(names, { operation: `core-restore:${app.appId}` }));
        preparedRetainedApps.push(app);
        // What the app was doing before this restore stopped it. An app an earlier restore left pending is
        // stopped only because of that, so the state remembered then still stands.
        if (app.serviceCredentialState === 'pending') app.serviceCredentialDesiredState ??= app.desiredState ?? 'running';
        else app.serviceCredentialDesiredState = app.desiredState ?? 'running';
        app.serviceCredentialState = 'pending';
        app.enabled = false;
        app.desiredState = 'stopped';
        await saveInstallMetadata(app);
        await quiesceAppCredentialRuntime(names, app.containers);
        // The app is stopped; the dashboard is told as well, but need not hear it: the restore-databases step
        // marks every credential not ready before the dashboard serves again. And a dashboard whose table an
        // unfinished restore already replaced cannot accept this at all, which must not stop the restore that
        // is run to finish the job (a rollback, or its second attempt).
        try {
          if (serving && (await appServiceCredentials.projection(app.appId))?.status === 'active') {
            await markCredentialReady(app.appId, false);
          }
        } catch (error) {
          logOperationFailure(`Telling the dashboard that kept app ${app.appId} is stopped`, error);
        }
      }
      for (const currentApp of currentApps) {
        if (!retainedIds.has(currentApp.appId)) await removeCurrentApp(currentApp.appId);
      }
    });

    await runStep('restore-volumes', 'never', async () => {
      emit('restore-volumes', 'Restoring persistent server configuration...');
      const machineConfig = config.setupMode ? await captureSetupMachineConfig() : [];
      if (config.setupMode) await prepareSetupRestoreVolumeMap(coreStagingDir, archivedRetainedApps);
      else await keepTargetAppNetworks(coreStagingDir);
      // The services to start again afterwards: those running now, and those a failed restore left stopped
      // when this restore is its rollback.
      const leftStopped = (config.stoppedServices ?? []).filter(name => coreServices.includes(name));
      quiesced = [...new Set([...await runningContainers(coreServices), ...leftStopped])].sort();
      progress.stoppedServices = [...quiesced];
      if (checkpoint) await checkpoint.rememberQuiesced(quiesced);
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
    });

    // ── Step 2: Restore youeye.yaml config ─────────────────
    await runStep('restore-config', 'replace', async () => {
      emit('restore-config', 'Restoring platform configuration...');
      try {
        await spineClient.setConfig(config.setupMode ? { ...spineConfig, setup_completed: false } : spineConfig);
      } catch (err) {
        throw new Error(`Could not restore the server configuration: ${err}`);
      }
    });

    // ── Step 3: Restore PostgreSQL databases ───────────────
    await runStep('restore-databases', 'never', async () => {
      // SQL import/migrations can still be running after an execution reply is
      // lost. A partial database step requires reconciliation, even though the
      // ordinary restore replaces each database from a complete source dump.
      await quiesceAppCredentialRuntime(quiesced);
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
      // The kept apps' YouEye ID clients are the box's, not the backup's (readKeptAppClients).
      await writeKeptAppClients(progress.keptAppClients ?? [], retainedApps);
      // No restored projection is active until a fresh authenticated push.
      await identityCommand(`UPDATE admission_outbox SET acknowledged_revision = 0`);
      await suspendRestoredAppCredentials();
    });
    // Importing retained roots is not an idempotent database replacement.
    // Existing roots may be foreign; uncertainty needs native reconciliation.
    await runStep('restore-retained-apps', 'never', () => restoreRetainedApps(coreStagingDir, archivedRetainedApps));
    // Keep UI and ordinary ingress stopped until identity, ownership and UI
    // databases are coherent. A failed database restore remains closed.
    await runStep('restart-services', 'replace', async () => {
      const restartFailures: string[] = [];
      const alreadyRunning = new Set(await runningContainers(quiesced));
      for (const container of quiesced) {
        if (alreadyRunning.has(container)) continue;
        try { await startContainerAfterRestore(container); }
        catch { restartFailures.push(container); }
      }
      if (restartFailures.length) {
        throw new Error(`Core services did not restart after identity restore: ${restartFailures.join(', ')}`);
      }
      if (quiesced.length > 0) await new Promise(resolve => setTimeout(resolve, 3000));
    });
	// The issuer pin lives in the portable youeye database. Never derive a route
	// from the fresh target's pre-restore database or mutable setup hostname.
	const restoredIdentity = config.setupMode ? await getIdentityConfig() : null;

    // ── Step 5: Restore Caddy config ───────────────────────
    await runStep('restore-caddy', 'never', async () => {
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
    });

    // ── Step 6: Restore Pi-Hole config ─────────────────────
    await runStep('restore-pihole', 'never', async () => {
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
    });

    await runStep('reconcile-apps', 'never', async () => {
      emit('reconcile-apps', 'Applying the selected application recovery plan...');
      for (const restoredApp of restoredApps) {
        if (!retainedIds.has(restoredApp.appId)) await clearRestoredAppRegistration(restoredApp);
      }
      // The dashboard's app credentials came back from the backup; this box's credential store did not move.
      // A kept app is reconciled below and a restored app gets a new credential from its reinstall. Every other
      // app either side knows is denied at one revision on both sides, or its next install could never publish.
      // An app left out here is still recoverable (removing it publishes the same fence), so a failure is logged.
      const known = new Set([...restoredApps.map(app => app.appId), ...await listRestoredAppCredentialIds(),
        ...await appServiceCredentials.installedCredentialIds()]);
      for (const appId of [...known].sort()) {
        if (retainedIds.has(appId)) continue;
        try { await fenceAbsentAppCredential(appId); }
        catch (error) { console.warn(`[restore] The dashboard still holds another service credential for ${appId}:`, error); }
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
          // This restore holds the maintenance lease of the app's containers until it ends (the watchdog must
          // not start a retained app while the core is being replaced); the reconcile works under that lease.
          await operateAppCredential(app.appId, { action: 'reconcile' }, { maintenance: retainedLeases.get(app.appId) });
        }
      }
      // Pointer's database came back from the backup; a kept app's AI key can be newer (reconcileKeptManagedAI).
      // The app works without AI meanwhile, so a failure here asks the owner to connect it again, not to restore.
      const withAI = retainedApps.filter(app => app.aiConnection);
      if (withAI.length) {
        const { waitForPointer } = await import('@/lib/pointer/lifecycle');
        const { reconcileKeptManagedAI } = await import('@/lib/market/managed-ai');
        const ready = await waitForPointer();
        for (const app of withAI) {
          try {
            if (!ready) throw new Error('AI is not ready');
            if (await reconcileKeptManagedAI(app.appId) === 'reconnected') {
              emit('reconcile-apps', `${app.appId} was given a new AI key: its AI connection was newer than the backup`);
            }
          } catch (error) {
            logOperationFailure(`Reconnecting the AI of kept app ${app.appId}`, error);
            emit('reconcile-apps', `${app.appId}: connect its AI again in its AI Settings (${error instanceof Error ? error.message : String(error)})`);
          }
        }
      }
    });

    if (marketState) {
      await runStep('restore-market-sources', 'replace', async () => {
        emit('restore-market-sources', 'Restoring Market sources...');
        const { restoreMarketState } = await import('./market-state');
        await restoreMarketState(marketState);
        // Copies of markets the restored list no longer names go; every market is read again on its next use.
        const { getConfiguredMarketSources } = await import('@/lib/market/source');
        const { removeMarketStoresExcept, requestMarketRefresh } = await import('@/lib/market/market-store');
        await removeMarketStoresExcept((await getConfiguredMarketSources()).map(source => source.id));
        requestMarketRefresh();
      });
    }

    // ── Restore each selected app ──────────────────────────
    // An app that cannot be restored does not cost the apps after it: the others are still restored, and the
    // restore fails at the end naming every app that did not come back. (This matters most in a rollback, where
    // each remaining app is one the box had.) Setup restore keeps its durable step order and stops at the first.
    const appFailures: string[] = [];
    for (const { appId, archivePath } of appArchives) {
      await runStep(`restore-app:${appId}`, 'never', async () => {
        emit('restore-app', `Restoring app: ${appId}...`);
        try {
          await restoreApp(
            { appId, archivePath, passphrase, encryption: readBackupEncryption(backupPath) },
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
      }).catch((error: unknown) => {
        if (checkpoint) throw error;
        appFailures.push(error instanceof Error ? error.message : String(error));
      });
    }
    if (appFailures.length > 0) throw new Error(appFailures.join('; '));

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
    for (const lease of retainedLeases.values()) lease.markFailed('Server restore requires reconciliation');
    logOperationFailure('Server restore', error);
    const notStopped: string[] = [];
    const serving = preparedRetainedApps.length > 0 && !(await uiStoppedByRestore().catch(() => false));
    for (const app of preparedRetainedApps) {
      app.serviceCredentialState = 'pending';
      app.enabled = false;
      app.desiredState = 'stopped';
      try {
        try { await saveInstallMetadata(app); } finally {
          await quiesceAppCredentialRuntime(app.containers.map(container =>
            container.containerName), app.containers);
        }
      } catch (cleanupError) {
        notStopped.push(app.appId);
        logOperationFailure(`Stopping kept app ${app.appId} after the failed restore`, cleanupError);
      }
      // The app is stopped and recorded as pending; telling the dashboard as well is not what the failure is
      // about. A dashboard that is starting, or half restored, must not replace the restore's own error.
      try {
        if (serving && (await appServiceCredentials.projection(app.appId))?.status === 'active') {
          await markCredentialReady(app.appId, false);
        }
      } catch (cleanupError) {
        logOperationFailure(`Telling the dashboard that kept app ${app.appId} is stopped`, cleanupError);
      }
    }
    // The reason the restore failed always comes first; what could not be cleaned up is added to it.
    if (notStopped.length > 0) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`${reason}; kept apps that could not be stopped and need reconciliation: ${notStopped.join(', ')}`, { cause: error });
    }
    throw error;
  } finally {
    releaseServices();
    for (const lease of retainedLeases.values()) lease.release();
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
