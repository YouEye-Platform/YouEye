/**
 * App Market deployment engine.
 * Unified YAML-driven installer — no more native/marketplace branching.
 *
 * Flow for ANY app:
 * 1. Parse & validate manifest
 * 2. Generate secrets
 * 3. Setup shared PostgreSQL (if database.mode === 'shared')
 * 4. Write config files
 * 5. Create Authentik SSO app (if sso section exists)
 * 6. Generate app token
 * 7. Build canonical context + resolve env_mapping
 * 8. Deploy containers (universal loop: lxd or oci per container)
 * 9. SSO configure steps (api or cli)
 * 10. Add Caddy route
 * 11. Save metadata
 * 12. Register with UI dashboard
 */

import type { OCIManifest } from '../infrastructure/types';
import type {
  AppManifest,
  ContainerSpec,
  ContainerMeta,
  InstallConfig,
  InstallEvent,
  InstallEventCallback,
  InstallMetadata,
  VariableContext,
  RestoreOptions,
} from './types';
import { readFile } from 'fs/promises';
import { resolveVariables, resolveEnvironment } from './variables';
import { writeAllConfigFiles } from './config-writer';
import { saveInstallMetadata, removeInstallMetadata } from './metadata';
import { upsertInstalledApp, removeInstalledApp } from './installed-apps';
import { deployOCIContainer, getContainerIP, containerExists } from '../infrastructure/oci-deployer';
import { deployLXDContainer } from '../infrastructure/lxd-deployer';
import { incusRequest } from '../incus/server';
import { applyResourcePolicy } from '../infrastructure/resource-policy';
import { execShell } from '../incus/server';
import {
  getOrCreateSecret,
  generatePassword,
  generateSecretKey,
  generateHexToken,
} from '../infrastructure/secrets';
import { addRoute, getRoutes, removeRoute, addAppRoutes } from '../caddy/client';
import type { EntranceConfig } from '../caddy/client';
import { waitForAppHealth, waitForPostgresHealth } from './health';
import {
  isAuthentikAvailable,
  createAuthentikOAuth2App,
  removeAuthentikOAuth2App,
  executeSSOSteps,
} from './sso-engine';
import {
  createAuthentikForwardAuthApp,
  removeAuthentikForwardAuthApp,
} from './authentik';
import { getContainerIP as getIncusContainerIP } from '../incus/container-ip';
import {
  buildCanonicalContext,
  resolveEnvMapping,
  generateAppToken,
  envToString,
  coerceInstallParams,
  getPlatformContext,
} from './platform-env';
import { getContainerName } from './engine-helpers';
import { CONTAINER_DOMAIN } from './constants';
import { ensureNetworkAcls, createContainerAcl, grantInternetAccess as grantInternet } from '../incus/network-acl';
import {
  createAppNetwork,
  addCaddyToAppNetwork,
  getSystemServices,
  addProxyDevices,
  buildAppNIC,
  setAppNetworkNAT,
} from '../incus/app-network';
import { activatePendingBridges, detectBridgeDependencies, createBridge } from '../bridges/manager';
import { generateSuggestionsForApp } from '../bridges/suggestions';

// ─── Install Rollback ─────────────────────────────────────

interface RollbackContext {
  containerNames: string[];
  appId: string;
  ssoSlug?: string;
  forwardAuthSlug?: string;
  subdomain?: string;
  domain?: string;
  dbName?: string;
  dbUser?: string;
}

async function rollbackInstall(
  ctx: RollbackContext,
  onEvent: InstallEventCallback,
  totalSteps: number
): Promise<void> {
  onEvent({ step: 0, totalSteps, status: 'running', message: 'Rolling back failed install...' });

  // 1. Remove containers
  for (const name of ctx.containerNames) {
    try {
      if (!(await containerExists(name))) continue;
      try {
        await incusRequest('PUT', `/1.0/instances/${name}/state`, { action: 'stop', force: true, timeout: 10 });
        await new Promise((r) => setTimeout(r, 2000));
      } catch {}
      const result = await incusRequest('DELETE', `/1.0/instances/${name}`);
      if (result.type === 'async' && result.operation) {
        try { await incusRequest('GET', `${result.operation}/wait?timeout=30`, undefined, { timeout: 40_000 }); } catch {}
      }
    } catch (err) {
      console.error(`[engine] Rollback: failed to remove container ${name}:`, err);
    }
  }

  // 2. Remove Caddy route
  if (ctx.subdomain && ctx.domain) {
    try {
      const hostname = `${ctx.subdomain}.${ctx.domain}`;
      const routes = await getRoutes();
      for (const route of routes) {
        if (route.hostname === hostname) {
          await removeRoute(route.id);
        }
      }
    } catch (err) {
      console.error('[engine] Rollback: failed to remove Caddy route:', err);
    }
  }

  // 3. Remove Authentik SSO app
  if (ctx.ssoSlug) {
    try {
      await removeAuthentikOAuth2App(ctx.ssoSlug);
    } catch (err) {
      console.error('[engine] Rollback: failed to remove SSO app:', err);
    }
  }

  // 3b. Remove Authentik forward-auth proxy app
  if (ctx.forwardAuthSlug) {
    try {
      await removeAuthentikForwardAuthApp(ctx.forwardAuthSlug);
    } catch (err) {
      console.error('[engine] Rollback: failed to remove forward-auth app:', err);
    }
  }

  // 4. Drop shared database
  if (ctx.dbName && ctx.dbUser) {
    try {
      await execShell('youeye-postgres',
        `psql -U youeye -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${ctx.dbName}' AND pid <> pg_backend_pid();"`,
        { timeout: 10_000 });
      await execShell('youeye-postgres', `psql -U youeye -c "DROP DATABASE IF EXISTS ${ctx.dbName}"`, { timeout: 10_000 });
      await execShell('youeye-postgres', `psql -U youeye -c "DROP USER IF EXISTS ${ctx.dbUser}"`, { timeout: 10_000 });
    } catch (err) {
      console.error('[engine] Rollback: failed to drop database:', err);
    }
  }

  // 5. Remove metadata and secrets
  try { await removeInstallMetadata(ctx.appId); } catch {}
  try { await removeInstalledApp(ctx.appId); } catch {}

  // 6. Clean up per-app bridge network
  try {
    const { removeCaddyFromAppNetwork, deleteAppNetwork } = await import('../incus/app-network');
    await removeCaddyFromAppNetwork(ctx.appId);
    await deleteAppNetwork(ctx.appId);
  } catch {}

  onEvent({ step: 0, totalSteps, status: 'running', message: 'Rollback complete — all resources cleaned up' });
}

// ─── Helpers ──────────────────────────────────────────────

function getSecretsPath(appId: string): string {
  return `app-${appId}`;
}

function countSteps(manifest: AppManifest, ssoEnabled: boolean): number {
  let steps = 1; // Generate secrets

  // Database setup
  const dbMode = manifest.database?.mode ?? 'none';
  if (dbMode === 'shared') steps++;

  if (manifest.configFiles.length > 0) steps++;
  if (ssoEnabled) steps++; // Create Authentik app

  // Containers
  steps += manifest.containers.length; // Deploy each
  steps += manifest.containers.filter((c) => c.healthCheck).length; // Health checks

  steps++; // Add Caddy route

  // SSO configure steps
  const hasConfigureSteps = ssoEnabled && manifest.sso && (
    (manifest.sso.setup?.method === 'api' && (manifest.sso.setup.api?.steps?.length ?? 0) > 0) ||
    (manifest.sso.setup?.method === 'cli' && (manifest.sso.setup.cli?.steps?.length ?? 0) > 0)
  );
  if (hasConfigureSteps) steps++;

  steps += 2; // Save metadata + register with UI
  return steps;
}

function emit(
  cb: InstallEventCallback,
  step: number,
  totalSteps: number,
  status: InstallEvent['status'],
  message: string,
  detail?: string
) {
  cb({ step, totalSteps, status, message, detail });
}

/**
 * Determine whether forward-auth should be applied for an app.
 * - If manifest.forwardAuth === 'enabled', always use it.
 * - If manifest.forwardAuth === 'disabled', never use it.
 * - Default ('default' or undefined): use forward-auth only if no native SSO section.
 */
function resolveForwardAuth(manifest: AppManifest, hasSSOEnabled: boolean): boolean {
  const fa = manifest.forwardAuth;
  if (fa === 'enabled') return true;
  if (fa === 'disabled') return false;
  // Default: use forward-auth when there's no native SSO section
  return !manifest.sso && !hasSSOEnabled;
}

async function ensureRoute(params: Parameters<typeof addRoute>[0]): Promise<void> {
  try {
    await addRoute(params);
  } catch (err) {
    if (err instanceof Error && err.message.includes('already exists')) return;
    throw err;
  }
}

// ─── Dashboard Registration ───────────────────────────────

async function readBridgeToken(): Promise<string | null> {
  try {
    const { readFileSync } = await import('fs');
    return readFileSync('/etc/youeye/ui-bridge-token', 'utf-8').trim();
  } catch {
    return process.env.UI_BRIDGE_TOKEN ?? null;
  }
}

async function registerAppWithUI(
  appId: string,
  name: string,
  subdomain: string,
  containerName: string,
  port: number,
  icon: string | null,
  appToken?: string,
  ssoEntryUrl?: string,
): Promise<void> {
  const uiIP = await getIncusContainerIP('youeye-ui');
  if (!uiIP) return;

  const bridgeToken = await readBridgeToken();
  const containerUrl = port ? `http://${containerName}.${CONTAINER_DOMAIN}:${port}` : `http://${containerName}.${CONTAINER_DOMAIN}`;

  // Hash the app token so YE-UI can validate future app requests by hash lookup
  let tokenHash: string | undefined;
  if (appToken) {
    const crypto = await import('crypto');
    tokenHash = crypto.createHash('sha256').update(appToken).digest('hex');
  }

  const res = await fetch(`http://${uiIP}:3000/api/v1/apps/register`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(bridgeToken ? { 'X-UI-Bridge-Token': bridgeToken } : {}),
    },
    body: JSON.stringify({ id: appId, name, container_url: containerUrl, subdomain, icon, token_hash: tokenHash, sso_entry_url: ssoEntryUrl }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.warn(`[engine] UI registration warning: ${res.status} ${text}`);
  }
}

// ─── Env File Writer ──────────────────────────────────────

async function writeEnvToContainer(
  containerName: string,
  env: Record<string, string>,
): Promise<void> {
  const content = envToString(env);
  const b64 = Buffer.from(content).toString('base64');
  await execShell(containerName, `echo '${b64}' | base64 -d > /etc/${containerName}.env`, { timeout: 10_000 });
}

// ─── Shared Postgres Setup ────────────────────────────────

async function setupSharedPostgres(
  dbName: string,
  dbUser: string,
  dbPassword: string,
): Promise<void> {
  const POSTGRES_CONTAINER = 'youeye-postgres';

  const checkUser = await execShell(
    POSTGRES_CONTAINER,
    `psql -U youeye -tAc "SELECT 1 FROM pg_roles WHERE rolname='${dbUser}'"`,
    { timeout: 10_000 }
  );

  if (!checkUser.stdout.includes('1')) {
    const result = await execShell(POSTGRES_CONTAINER, `psql -U youeye -c "CREATE USER ${dbUser} WITH PASSWORD '${dbPassword}'"`, { timeout: 10_000 });
    if (result.exitCode !== 0) throw new Error(`Failed to create user ${dbUser}: ${result.stderr}`);
  } else {
    const result = await execShell(POSTGRES_CONTAINER, `psql -U youeye -c "ALTER USER ${dbUser} WITH PASSWORD '${dbPassword}'"`, { timeout: 10_000 });
    if (result.exitCode !== 0) throw new Error(`Failed to update password for ${dbUser}: ${result.stderr}`);
  }

  const checkDB = await execShell(POSTGRES_CONTAINER, `psql -U youeye -tAc "SELECT 1 FROM pg_database WHERE datname='${dbName}'"`, { timeout: 10_000 });

  if (checkDB.stdout.includes('1')) {
    await execShell(POSTGRES_CONTAINER, `psql -U youeye -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${dbName}' AND pid <> pg_backend_pid();"`, { timeout: 10_000 });
    const dropResult = await execShell(POSTGRES_CONTAINER, `psql -U youeye -c "DROP DATABASE ${dbName}"`, { timeout: 10_000 });
    if (dropResult.exitCode !== 0) throw new Error(`Failed to drop stale database ${dbName}: ${dropResult.stderr}`);
  }

  const createResult = await execShell(POSTGRES_CONTAINER, `psql -U youeye -c "CREATE DATABASE ${dbName} OWNER ${dbUser}"`, { timeout: 10_000 });
  if (createResult.exitCode !== 0) throw new Error(`Failed to create database ${dbName}: ${createResult.stderr}`);
}

// ─── Secret Generator ─────────────────────────────────────

function getGenerator(type: string, length: number): () => string {
  switch (type) {
    case 'password': return () => generatePassword(length);
    case 'secretKey': return () => generateSecretKey(length);
    case 'hexToken': return () => generateHexToken(length);
    default: return () => generatePassword(length);
  }
}

// ─── OCI Manifest Builder ─────────────────────────────────

function buildOCIManifest(
  spec: ContainerSpec,
  containerName: string,
  appId: string,
  resolvedEnv: Record<string, string>,
): OCIManifest {
  const volumes = spec.volumes.map((v) => ({
    host: v.host,
    container: v.container,
  }));

  return {
    name: appId,
    displayName: containerName,
    image: spec.image,
    containerName,
    command: spec.command,
    ports: [],
    environment: resolvedEnv,
    volumes,
  };
}

// ─── Gitea Helpers ────────────────────────────────────────

const GITEA_BASE = 'https://git.byka.wtf';

function giteaRepoFromSource(repo: string): { org: string; repo: string } {
  const parts = repo.split('/');
  return { org: parts[0] || 'potemsla', repo: parts[parts.length - 1] };
}

// ─── Main Install Function (v2: unified) ──────────────────

export async function installApp(
  manifest: AppManifest,
  config: InstallConfig,
  onEvent: InstallEventCallback,
  signal?: AbortSignal,
  restoreOptions?: RestoreOptions
): Promise<void> {
  const appId = manifest.metadata.id;
  const secretsPath = getSecretsPath(appId);

  // Determine SSO support from manifest
  const hasSSOSection = !!manifest.sso;
  const ssoEnabled = hasSSOSection && (await isAuthentikAvailable());
  const totalSteps = countSteps(manifest, ssoEnabled);
  let step = 0;

  const dbMode = manifest.database?.mode ?? 'none';
  const dbName = manifest.database?.name ?? '';
  const dbUser = manifest.database?.user ?? '';

  // Rollback context — tracks resources created so far for cleanup on failure
  const rollbackCtx: RollbackContext = {
    containerNames: [],
    appId,
    subdomain: config.subdomain,
    domain: config.domain,
    dbName: (dbMode === 'shared' && dbName) ? dbName : undefined,
    dbUser: (dbMode === 'shared' && dbUser) ? dbUser : undefined,
  };

  function checkCancelled() {
    if (signal?.aborted) throw new Error('Installation cancelled by user');
  }

  // ── Step 1: Generate secrets ────────────────────────────

  checkCancelled();
  step++;
  const secrets: Record<string, string> = {};

  if (restoreOptions?.skipSecrets) {
    emit(onEvent, step, totalSteps, 'running', 'Reading restored secrets...');
    for (const secret of manifest.secrets) {
      const secretValue = await readFile(`/var/lib/youeye/app-${appId}/${secret.file}`, 'utf-8');
      secrets[secret.name] = secretValue.trim();
    }
    emit(onEvent, step, totalSteps, 'success', 'Secrets read from backup');
  } else {
    emit(onEvent, step, totalSteps, 'running', 'Generating secrets...');
    for (const secret of manifest.secrets) {
      const generator = getGenerator(secret.generator, secret.length);
      secrets[secret.name] = await getOrCreateSecret(secretsPath, secret.file, generator);
    }
    emit(onEvent, step, totalSteps, 'success', 'Secrets generated');
  }

  // ── Step 2: Setup shared PostgreSQL ─────────────────────

  let dbPassword = '';
  if (dbMode === 'shared' && dbName && dbUser) {
    checkCancelled();
    step++;
    dbPassword = secrets.db_password || generatePassword(32);
    if (restoreOptions?.skipDatabase) {
      emit(onEvent, step, totalSteps, 'skipped', 'Database setup skipped (restored from backup)');
    } else {
      emit(onEvent, step, totalSteps, 'running', 'Setting up shared database...');
      try {
        await setupSharedPostgres(dbName, dbUser, dbPassword);
        emit(onEvent, step, totalSteps, 'success', 'Database ready');
      } catch (err) {
        emit(onEvent, step, totalSteps, 'error', 'Failed to setup database', String(err));
        throw err;
      }
    }
  }

  // ── Step 3: Write config files ──────────────────────────

  if (manifest.configFiles.length > 0) {
    checkCancelled();
    step++;
    if (restoreOptions?.skipConfigFiles) {
      emit(onEvent, step, totalSteps, 'skipped', 'Config files skipped (restored from backup)');
    } else {
      emit(onEvent, step, totalSteps, 'running', 'Writing configuration files...');
      // We need a preliminary context for config file variable resolution
      const prelimCtx = await buildCanonicalContext(manifest, config, undefined, dbPassword);
      prelimCtx.secrets = secrets;
      try {
        await writeAllConfigFiles(manifest.configFiles, prelimCtx);
        emit(onEvent, step, totalSteps, 'success', 'Configuration files written');
      } catch (err) {
        emit(onEvent, step, totalSteps, 'error', 'Failed to write config files', String(err));
        throw err;
      }
    }
  }

  // ── Step 4: Pre-deploy SSO — create Authentik app ───────

  let ssoSlug: string | undefined;
  let ssoClientId: string | undefined;
  let ssoResult: { clientId: string; clientSecret: string; slug: string } | undefined;

  if (ssoEnabled && manifest.sso) {
    checkCancelled();
    step++;
    emit(onEvent, step, totalSteps, 'running', 'Creating Authentik SSO application...');
    try {
      ssoSlug = `youeye-app-${appId}`;
      const appUrl = `https://${config.subdomain}.${config.domain}`;

      // Build redirect URIs from callback_path + additional_callbacks
      const redirectUris: { matching_mode: 'strict'; url: string }[] = [];
      const prelimCtx = await buildCanonicalContext(manifest, config, undefined, dbPassword);
      prelimCtx.secrets = secrets;

      if (manifest.sso.callback_path) {
        const resolvedCallbackPath = resolveVariables(manifest.sso.callback_path, prelimCtx);
        redirectUris.push({ matching_mode: 'strict', url: `${appUrl}${resolvedCallbackPath}` });
      }

      for (const cb of manifest.sso.additional_callbacks || []) {
        redirectUris.push({ matching_mode: 'strict', url: cb });
      }

      const result = await createAuthentikOAuth2App({
        slug: ssoSlug,
        name: manifest.metadata.name,
        redirectUris,
        launchUrl: appUrl,
        implicitConsent: true,
      });

      ssoClientId = result.clientId;
      ssoResult = { clientId: result.clientId, clientSecret: result.clientSecret, slug: ssoSlug };
      rollbackCtx.ssoSlug = ssoSlug;

      emit(onEvent, step, totalSteps, 'success', 'Authentik SSO application created');
    } catch (err) {
      emit(onEvent, step, totalSteps, 'error', 'Failed to create SSO application', String(err));
      await rollbackInstall(rollbackCtx, onEvent, totalSteps);
      throw err;
    }
  }

  // ── Step 4b: Forward-auth proxy (for apps without native SSO) ──
  // If the app has no `sso` section but forward-auth is not disabled,
  // create an Authentik forward-auth proxy provider so Caddy can gate access.

  let forwardAuthEnabled = false;
  const useForwardAuth = resolveForwardAuth(manifest, ssoEnabled);

  if (useForwardAuth && (await isAuthentikAvailable())) {
    try {
      const faSlug = `youeye-fa-${appId}`;
      const externalHost = `https://${config.subdomain}.${config.domain}`;
      await createAuthentikForwardAuthApp({
        slug: faSlug,
        name: `YouEye - ${manifest.metadata.name}`,
        externalHost,
      });
      rollbackCtx.forwardAuthSlug = faSlug;
      forwardAuthEnabled = true;
      emit(onEvent, step, totalSteps, 'success', 'Forward-auth proxy configured');
    } catch (err) {
      // Forward-auth is non-fatal — app still works, just without SSO gating
      console.warn('[engine] Forward-auth setup failed (non-fatal):', err);
    }
  }

  // ── Step 5: Create per-app bridge + build canonical context ──

  // Create bridge FIRST — context build needs to know if proxy devices are used.
  // NAT is always enabled during install — apps need internet to pull images/packages.
  // Post-install, NAT can be toggled off for apps that shouldn't have outbound internet.
  let appBridgeName: string | undefined;
  const wantsInternet = manifest.containers.some(c => c.network === 'internet');

  try {
    const { bridgeName } = await createAppNetwork(appId, { nat: true });
    appBridgeName = bridgeName;
    emit(onEvent, step, totalSteps, 'success', `App network created: ${bridgeName}`);
  } catch (err) {
    console.warn('[engine] Failed to create app network, falling back to incusbr0:', err);
  }

  const appToken = await generateAppToken(appId);
  const ctx = await buildCanonicalContext(manifest, config, ssoResult, dbPassword, appToken, !!appBridgeName);
  ctx.secrets = secrets;

  // Populate installParams with type coercion
  if (config.installParams) {
    ctx.installParams = coerceInstallParams(
      config.installParams,
      manifest.installParams || [],
    );
  }

  // Resolve env_mapping once — used for all containers
  const envFromMapping = manifest.env_mapping
    ? resolveEnvMapping(manifest.env_mapping, ctx)
    : {};

  // Resolve volume host paths in the context
  for (const containerSpec of manifest.containers) {
    for (const vol of containerSpec.volumes) {
      vol.host = resolveVariables(vol.host, ctx);
    }
  }

  // ── Step 6: Deploy containers (universal loop) ──────────

  const containerMetas: ContainerMeta[] = [];
  const containerNames: string[] = [];
  let primaryContainerName = '';
  let primaryPort = 0;

  // Build NIC device config for per-app bridge (if available)
  let appNIC: Record<string, Record<string, string>> | undefined;
  if (appBridgeName) {
    try {
      appNIC = await buildAppNIC(appId);
    } catch (err) {
      console.warn('[engine] Failed to build app NIC:', err);
    }
  }

  try {
    for (const containerSpec of manifest.containers) {
      const containerName = getContainerName(appId, containerSpec.name, manifest.containers.length);
      containerNames.push(containerName);
      rollbackCtx.containerNames.push(containerName);

      const isPrimary = containerSpec.primary || manifest.containers.length === 1;
      if (isPrimary) {
        primaryContainerName = containerName;
        primaryPort = containerSpec.port || 3000;
      }

      containerMetas.push({
        name: containerSpec.name,
        containerName,
        type: containerSpec.type,
        network: containerSpec.network || 'isolated',
      });

      checkCancelled();
      step++;
      emit(onEvent, step, totalSteps, 'running', `Deploying ${containerName}...`);

      try {
        if (containerSpec.type === 'lxd') {
          // ── LXD container deployment ──────────────────
          const source = containerSpec.source;
          if (!source) throw new Error(`LXD container ${containerSpec.name} missing source config`);
          const gitInfo = giteaRepoFromSource(source.repo);

          await deployLXDContainer(
            {
              name: appId,
              displayName: manifest.metadata.name,
              containerName,
              image: containerSpec.image,
              imageServer: 'https://images.linuxcontainers.org',
              imageProtocol: 'simplestreams',
              nodeVersion: source.nodeVersion || '22.x',
              appDir: source.appDir || '/opt/app',
              port: containerSpec.port || 3000,
            },
            {
              spineSocketPath: '/var/run/spine/spine.sock',
              giteaBaseURL: GITEA_BASE,
              giteaOrg: gitInfo.org,
              giteaRepo: gitInfo.repo,
              tagPrefix: source.tagPrefix,
            },
            appNIC,
          );

          // Write env file to LXD container
          const staticEnv = resolveEnvironment(containerSpec.environment || {}, ctx);
          const fullEnv = { ...envFromMapping, ...staticEnv };
          await writeEnvToContainer(containerName, fullEnv);

          // Restart service to pick up env
          await execShell(containerName, `systemctl restart ${containerName}`, { timeout: 15_000 });

          // Post-deploy commands
          if (containerSpec.postDeploy && containerSpec.postDeploy.length > 0) {
            for (const cmd of containerSpec.postDeploy) {
              await execShell(containerName, cmd.exec, { timeout: cmd.timeout });
            }
          }
        } else {
          // ── OCI container deployment ─────────────────
          const staticEnv = resolveEnvironment(containerSpec.environment || {}, ctx);
          const fullEnv = { ...envFromMapping, ...staticEnv };
          const ociManifest = buildOCIManifest(containerSpec, containerName, appId, fullEnv);
          await deployOCIContainer(ociManifest, '', appNIC);
        }

        await applyResourcePolicy(containerName, 'normal');

        emit(onEvent, step, totalSteps, 'success', `${containerName} deployed`);
      } catch (err) {
        emit(onEvent, step, totalSteps, 'error', `Failed to deploy ${containerName}`, String(err));
        throw err;
      }

      // Health check
      if (containerSpec.healthCheck) {
        step++;
        emit(onEvent, step, totalSteps, 'running', `Waiting for ${containerName} to be healthy...`);

        let healthy = false;
        if (containerSpec.healthCheck.type === 'http') {
          healthy = await waitForAppHealth(
            containerName,
            containerSpec.port || 80,
            containerSpec.healthCheck.path,
            containerSpec.healthCheck.timeout
          );
        } else if (containerSpec.healthCheck.type === 'postgres') {
          healthy = await waitForPostgresHealth(
            containerName,
            containerSpec.healthCheck.user,
            containerSpec.healthCheck.timeout
          );
        }

        emit(onEvent, step, totalSteps, healthy ? 'success' : 'error',
          healthy ? `${containerName} is healthy` : `${containerName} health check timed out`);
        if (!healthy) throw new Error(`Health check failed for ${containerName}`);
      }
    }
  } catch (err) {
    await rollbackInstall(rollbackCtx, onEvent, totalSteps);
    throw err;
  }

  // ── Step 6b: Network isolation — proxy devices + Caddy NIC ──────
  // Per-app bridge provides structural isolation.
  // Proxy devices expose system services (postgres, authentik, UI) at localhost:{port}.
  // Caddy NIC lets the reverse proxy reach the app on its bridge.

  if (appBridgeName) {
    try {
      const needsSharedDb = (manifest.database?.mode ?? 'none') === 'shared';
      const needsSSO = ssoEnabled;

      // Add proxy devices for system services to each container
      const services = await getSystemServices({ needsSharedDb, needsSSO });
      for (const cn of containerNames) {
        await addProxyDevices(cn, services);
      }

      // Hot-plug Caddy NIC onto the app bridge (Docker/Traefik model)
      await addCaddyToAppNetwork(appId);

      emit(onEvent, step, totalSteps, 'success', `Network isolation configured for ${containerNames.length} containers`);
    } catch (netErr) {
      console.warn('[engine] Network configuration warning:', netErr);
    }
  } else {
    // Fallback: use legacy ACL system for containers on incusbr0
    try {
      await ensureNetworkAcls();
      const needsSharedDb = (manifest.database?.mode ?? 'none') === 'shared';
      const needsSSO = ssoEnabled;

      const containerIPs = new Map<string, string>();
      for (const cn of containerNames) {
        const ip = await getContainerIP(cn);
        if (ip) containerIPs.set(cn, ip);
      }

      for (const containerSpec of manifest.containers) {
        const cn = getContainerName(appId, containerSpec.name, manifest.containers.length);
        const siblingIPs = containerNames
          .filter(s => s !== cn)
          .map(s => containerIPs.get(s))
          .filter((ip): ip is string => !!ip);

        await createContainerAcl(cn, { siblingIPs, needsSharedDb, needsSSO });

        if (containerSpec.network === 'internet') {
          await grantInternet(cn, [], true);
        }
      }
      emit(onEvent, step, totalSteps, 'success', `Network isolation configured (legacy ACL) for ${containerNames.length} containers`);
    } catch (aclErr) {
      console.warn('[engine] ACL configuration warning:', aclErr);
    }
  }

  // ── Steps 7-10: Post-deploy (SSO configure, Caddy, metadata, dashboard)
  // All wrapped in try/catch for comprehensive rollback on failure.

  try {

  // ── Step 7: SSO Configure Steps ─────────────────────────

  const hasConfigureSteps = ssoEnabled && manifest.sso?.setup && (
    (manifest.sso.setup.method === 'api' && (manifest.sso.setup.api?.steps?.length ?? 0) > 0) ||
    (manifest.sso.setup.method === 'cli' && (manifest.sso.setup.cli?.steps?.length ?? 0) > 0)
  );

  // Inject Caddy root CA into OCI containers that use SSO, so they can
  // reach Authentik over HTTPS with self-signed certs.
  if (ssoEnabled) {
    for (const containerSpec of manifest.containers) {
      if (containerSpec.type === 'oci') {
        const cn = getContainerName(appId, containerSpec.name, manifest.containers.length);
        try {
          await injectCaddyRootCA(cn);
        } catch (err) {
          console.warn(`[engine] CA cert injection warning for ${cn}:`, err);
        }
      }
    }
  }

  if (hasConfigureSteps) {
    checkCancelled();
    // Get primary container IP for SSO configuration
    const primaryIP = await getContainerIP(primaryContainerName);
    if (primaryIP) {
      ctx.container = { ip: primaryIP, port: primaryPort };
    }

    step++;
    emit(onEvent, step, totalSteps, 'running', `Configuring ${manifest.metadata.name} SSO...`);
    try {
      if (manifest.sso!.setup?.method === 'cli' && manifest.sso!.setup.cli?.steps) {
        // CLI-based SSO setup: exec commands in primary container
        for (const cliStep of manifest.sso!.setup.cli.steps) {
          const resolvedCmd = resolveVariables(cliStep.exec, ctx);
          await execShell(primaryContainerName, resolvedCmd, { timeout: cliStep.timeout });
        }
      } else {
        // API-based SSO setup
        await executeSSOSteps(manifest.sso!, ctx);
      }
      emit(onEvent, step, totalSteps, 'success', `${manifest.metadata.name} SSO configured`);
    } catch (err) {
      emit(onEvent, step, totalSteps, 'error', 'SSO configuration failed', String(err));
      throw err;
    }
  }

  // ── Step 8: Add Caddy route ─────────────────────────────

  checkCancelled();
  step++;
  emit(onEvent, step, totalSteps, 'running', 'Configuring reverse proxy...');
  try {
    // Build forward-auth config for Caddy if enabled
    let forwardAuthConfig: { upstreamDial: string; uri: string; copyHeaders: string[] } | undefined;
    if (forwardAuthEnabled) {
      const authentikIP = await getIncusContainerIP('youeye-authentik');
      if (authentikIP) {
        forwardAuthConfig = {
          upstreamDial: `${authentikIP}:9000`,
          uri: '/outpost.goauthentik.io/auth/caddy',
          copyHeaders: [
            'X-authentik-username',
            'X-authentik-groups',
            'X-authentik-email',
            'X-authentik-name',
            'X-authentik-uid',
          ],
        };
      }
    }

    const hostname = `${config.subdomain}.${config.domain}`;

    if (manifest.entrances && manifest.entrances.length > 0) {
      // Multi-entrance routing: each entrance gets its own Caddy route
      const entrances: EntranceConfig[] = manifest.entrances.map((e) => ({
        name: e.name,
        path: e.path || '/',
        port: e.port,
        container: e.container,
        protocol: e.protocol || 'http',
        authLevel: e.authLevel || 'private',
        stripPath: e.stripPath || false,
      }));

      await addAppRoutes(appId, hostname, entrances, primaryContainerName, forwardAuthConfig);
      emit(onEvent, step, totalSteps, 'success', `Routes added: ${entrances.length} entrances for ${hostname}`);
    } else {
      // Single-route (standard)
      // For per-app bridge containers, use IP instead of DNS name.
      // Caddy's DNS resolver (incusbr0) can't resolve names on app bridges.
      let routeUpstream = primaryContainerName;
      if (appBridgeName) {
        const appIP = await getIncusContainerIP(primaryContainerName);
        if (appIP) routeUpstream = appIP;
      }
      await ensureRoute({
        hostname,
        path: '/*',
        upstream: routeUpstream,
        port: primaryPort,
        forwardAuth: forwardAuthConfig,
      });
      emit(onEvent, step, totalSteps, 'success', `Route added: ${hostname}`);
    }
  } catch (err) {
    emit(onEvent, step, totalSteps, 'error', 'Failed to configure route', String(err));
    throw err;
  }

  // ── Step 9: Save metadata ───────────────────────────────

  step++;
  emit(onEvent, step, totalSteps, 'running', 'Saving configuration...');
  const installedVersion = manifest.version ?? '';

  const meta: InstallMetadata = {
    appId,
    integration: manifest.integration,
    subdomain: config.subdomain,
    domain: config.domain,
    enableSSO: ssoEnabled,
    forwardAuthEnabled,
    installedAt: new Date().toISOString(),
    installedVersion,
    containers: containerMetas,
    ssoSlug,
    ssoClientId,
    forwardAuthSlug: rollbackCtx.forwardAuthSlug,
    manifestSource: config.repoUrl || 'appmarket',
    credentials: manifest.credentials?.length
      ? manifest.credentials.map((c) => ({ label: c.label, username: c.username, passwordSecret: c.passwordSecret }))
      : undefined,
    ssoEntryUrl: manifest.sso?.entry_url
      ? resolveVariables(manifest.sso.entry_url, ctx)
      : undefined,
    databaseMode: manifest.database?.mode ?? 'none',
    hasSSO: ssoEnabled,
    usePerAppBridge: !!appBridgeName,
  };
  await saveInstallMetadata(meta);

  try {
    await upsertInstalledApp({
      appId,
      type: manifest.integration,
      installedVersion,
      subdomain: config.subdomain,
      ssoSlug,
      forwardAuthEnabled,
    });
  } catch (err) {
    console.error('[engine] Failed to track installed app in DB:', err);
  }

  emit(onEvent, step, totalSteps, 'success', 'Configuration saved');

  // ── Step 10: Register with UI dashboard ─────────────────

  step++;
  emit(onEvent, step, totalSteps, 'running', 'Registering with dashboard...');
  try {
    const displayName = config.customName || manifest.metadata.name;
    const displayIcon = config.customIcon || manifest.metadata.iconUrl || manifest.metadata.icon || null;
    const ssoEntryUrl = manifest.sso?.entry_url
      ? resolveVariables(manifest.sso.entry_url, ctx)
      : undefined;
    await registerAppWithUI(appId, displayName, config.subdomain, primaryContainerName, primaryPort, displayIcon, appToken, ssoEntryUrl);
    emit(onEvent, step, totalSteps, 'success', 'Registered with dashboard');
  } catch (err) {
    emit(onEvent, step, totalSteps, 'success', `Dashboard registration skipped: ${err}`);
  }

  // ── Step 11: Detect bridge dependencies from env_mapping ──

  if (manifest.env_mapping) {
    try {
      const deps = detectBridgeDependencies(manifest.env_mapping, appId);
      for (const dep of deps) {
        await createBridge({
          from: appId,
          to: dep.targetAppId,
          envMappings: dep.envMappings,
          approvedBy: 'auto',
        });
      }
      if (deps.length > 0) {
        emit(onEvent, step, totalSteps, 'success', `Detected ${deps.length} bridge dependencies`);
      }
    } catch (err) {
      console.warn('[engine] Bridge dependency detection warning:', err);
    }
  }

  // ── Step 12: Activate pending bridges targeting this app ──

  try {
    const platform = await getPlatformContext();
    const domain = platform.domain || config.domain;
    const activated = await activatePendingBridges(
      appId,
      primaryContainerName,
      primaryPort,
      config.subdomain,
      domain,
    );
    if (activated.length > 0) {
      emit(onEvent, step, totalSteps, 'success', `Activated ${activated.length} pending bridges`);
    }
  } catch (err) {
    console.warn('[engine] Pending bridge activation warning:', err);
  }

  // ── Step 13: Generate connection suggestions ──────────────

  try {
    const suggestions = await generateSuggestionsForApp(manifest);
    if (suggestions.length > 0) {
      emit(onEvent, step, totalSteps, 'success', `Generated ${suggestions.length} connection suggestions`);
    }
  } catch (err) {
    console.warn('[engine] Suggestions generation warning:', err);
  }

  } catch (err) {
    // Comprehensive rollback: clean up containers, DB, SSO, Caddy, metadata
    await rollbackInstall(rollbackCtx, onEvent, totalSteps);
    throw err;
  }

  // Post-install: disable NAT on the app bridge if the app doesn't need internet.
  // NAT was enabled during install so containers could pull packages/images.
  if (appBridgeName && !wantsInternet) {
    await setAppNetworkNAT(appId, false);
  }

  emit(onEvent, step, totalSteps, 'success', `${manifest.metadata.name} installed successfully!`);
}

/**
 * Inject Caddy's root CA certificate into an OCI container's trust store.
 * This allows the container to make HTTPS calls to other services
 * (like Authentik) that use Caddy's self-signed certificates.
 *
 * Handles two scenarios:
 * 1. System CA store: creates the directory if missing, runs update-ca-certificates
 *    (works for curl, Python requests, Go apps, etc.)
 * 2. Node.js: writes cert to /tmp/caddy-root.crt — Node.js ignores system CAs
 *    but reads NODE_EXTRA_CA_CERTS (set separately in container env).
 *
 * For Node.js apps, the engine also sets NODE_TLS_REJECT_UNAUTHORIZED=0
 * in the container environment when SSO is enabled. This is a practical
 * necessity because NODE_EXTRA_CA_CERTS is only read at process startup,
 * and the cert is injected after the container is already running.
 */
async function injectCaddyRootCA(containerName: string): Promise<void> {
  // Read the Caddy root CA from the Caddy container
  const { stdout: certPem } = await execShell(
    'youeye-caddy',
    'cat /data/caddy/pki/authorities/local/root.crt',
    { timeout: 5_000 }
  );
  if (!certPem || !certPem.includes('BEGIN CERTIFICATE')) return;

  // Write the cert into the target container:
  // 1. System CA store (mkdir -p in case the dir doesn't exist in OCI images)
  // 2. /tmp/caddy-root.crt as a fallback for NODE_EXTRA_CA_CERTS
  const escaped = certPem.replace(/'/g, "'\\''");
  await execShell(containerName,
    `mkdir -p /usr/local/share/ca-certificates/ && ` +
    `echo '${escaped}' > /usr/local/share/ca-certificates/caddy-root.crt && ` +
    `echo '${escaped}' > /tmp/caddy-root.crt && ` +
    `update-ca-certificates 2>/dev/null || true`,
    { timeout: 10_000 }
  );
}

// Re-export for backward compat
export { getContainerName } from './engine-helpers';
