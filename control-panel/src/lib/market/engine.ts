/**
 * App Market deployment engine (v2).
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
import { saveInstallMetadata } from './metadata';
import { upsertInstalledApp } from './installed-apps';
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
import { addRoute } from '../caddy/client';
import { waitForAppHealth, waitForPostgresHealth } from './health';
import {
  isAuthentikAvailable,
  createAuthentikOAuth2App,
  executeSSOSteps,
} from './sso-engine';
import { getContainerIP as getIncusContainerIP } from '../incus/container-ip';
import {
  buildCanonicalContext,
  resolveEnvMapping,
  generateAppToken,
  envToString,
} from './platform-env';
import { getContainerName } from './engine-helpers';
import { resolveConnectors } from './engine-connectors';
import { CONTAINER_DOMAIN } from './constants';

// ─── Install Rollback ─────────────────────────────────────

async function rollbackContainers(
  containerNames: string[],
  onEvent: InstallEventCallback,
  totalSteps: number
): Promise<void> {
  if (containerNames.length === 0) return;

  onEvent({ step: 0, totalSteps, status: 'running', message: `Rolling back ${containerNames.length} container(s)...` });

  for (const name of containerNames) {
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
      console.error(`[engine] Failed to roll back container ${name}:`, err);
    }
  }

  onEvent({ step: 0, totalSteps, status: 'running', message: 'Rollback complete' });
}

// ─── Helpers ──────────────────────────────────────────────

function getSecretsPath(appId: string): string {
  return `app-${appId}`;
}

function countSteps(manifest: AppManifest, ssoEnabled: boolean): number {
  let steps = 1; // Generate secrets

  // Database setup
  const dbMode = manifest.database?.mode || (manifest.features?.requiresSharedPostgres ? 'shared' : 'none');
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
    (manifest.sso.setup?.method === 'cli' && (manifest.sso.setup.cli?.steps?.length ?? 0) > 0) ||
    (manifest.sso.configure?.type === 'http-api' && (manifest.sso.configure.steps?.length ?? 0) > 0)
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
): Promise<void> {
  const uiIP = await getIncusContainerIP('youeye-ui');
  if (!uiIP) return;

  const bridgeToken = await readBridgeToken();
  const containerUrl = port ? `http://${containerName}.${CONTAINER_DOMAIN}:${port}` : `http://${containerName}.${CONTAINER_DOMAIN}`;

  const res = await fetch(`http://${uiIP}:3000/api/v1/apps/register`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(bridgeToken ? { 'X-UI-Bridge-Token': bridgeToken } : {}),
    },
    body: JSON.stringify({ id: appId, name, container_url: containerUrl, subdomain, icon }),
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

  // Determine database mode (v2 field or legacy fallback)
  const dbMode = manifest.database?.mode || (manifest.features?.requiresSharedPostgres ? 'shared' : 'none');
  const dbName = manifest.database?.name || manifest.sharedPostgres?.database || '';
  const dbUser = manifest.database?.user || manifest.sharedPostgres?.user || '';

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

      if (manifest.sso.callback_path) {
        redirectUris.push({ matching_mode: 'strict', url: `${appUrl}${manifest.sso.callback_path}` });
      }

      // Legacy v1 redirectUris
      if (manifest.sso.redirectUris) {
        const prelimCtx = await buildCanonicalContext(manifest, config, undefined, dbPassword);
        prelimCtx.secrets = secrets;
        for (const r of manifest.sso.redirectUris) {
          redirectUris.push({ matching_mode: 'strict', url: resolveVariables(r.url, prelimCtx) });
        }
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

      emit(onEvent, step, totalSteps, 'success', 'Authentik SSO application created');
    } catch (err) {
      emit(onEvent, step, totalSteps, 'error', 'Failed to create SSO application', String(err));
      throw err;
    }
  }

  // ── Step 5: Generate app token + build canonical context ──

  const appToken = await generateAppToken(appId);
  const ctx = await buildCanonicalContext(manifest, config, ssoResult, dbPassword, appToken);
  ctx.secrets = secrets;

  // Populate installParams
  if (config.installParams) {
    ctx.installParams = config.installParams;
  }

  // Resolve env_mapping once — used for all containers
  const envFromMapping = manifest.env_mapping
    ? resolveEnvMapping(manifest.env_mapping, ctx)
    : {};

  // Also resolve connector env vars
  const connectorEnv = await resolveConnectors(manifest);

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

  try {
    for (const containerSpec of manifest.containers) {
      const containerName = getContainerName(appId, containerSpec.name, manifest.containers.length);
      containerNames.push(containerName);

      const isPrimary = containerSpec.primary || manifest.containers.length === 1;
      if (isPrimary) {
        primaryContainerName = containerName;
        primaryPort = containerSpec.port || 3000;
      }

      containerMetas.push({
        name: containerSpec.name,
        containerName,
        type: containerSpec.type,
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
            }
          );

          // Write env file to LXD container
          const staticEnv = resolveEnvironment(containerSpec.environment || {}, ctx);
          const fullEnv = { ...envFromMapping, ...staticEnv, ...connectorEnv };
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
          const fullEnv = { ...envFromMapping, ...staticEnv, ...connectorEnv };
          const ociManifest = buildOCIManifest(containerSpec, containerName, appId, fullEnv);
          await deployOCIContainer(ociManifest, '');
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
      }
    }
  } catch (err) {
    await rollbackContainers(containerNames, onEvent, totalSteps);
    throw err;
  }

  // ── Step 7: SSO Configure Steps ─────────────────────────

  const ssoSetupMethod = manifest.sso?.setup?.method || manifest.sso?.configure?.type;
  const hasConfigureSteps = ssoEnabled && manifest.sso && (
    (ssoSetupMethod === 'api' && ((manifest.sso.setup?.api?.steps?.length ?? 0) > 0 || (manifest.sso.configure?.steps?.length ?? 0) > 0)) ||
    (ssoSetupMethod === 'cli' && (manifest.sso.setup?.cli?.steps?.length ?? 0) > 0) ||
    (ssoSetupMethod === 'http-api' && (manifest.sso.configure?.steps?.length ?? 0) > 0)
  );

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
        // API-based SSO setup (v2 or legacy v1)
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
    await ensureRoute({
      hostname: `${config.subdomain}.${config.domain}`,
      path: '/*',
      upstream: primaryContainerName,
      port: primaryPort,
    });
    emit(onEvent, step, totalSteps, 'success', `Route added: ${config.subdomain}.${config.domain}`);
  } catch (err) {
    emit(onEvent, step, totalSteps, 'error', 'Failed to configure route', String(err));
    throw err;
  }

  // ── Step 9: Save metadata ───────────────────────────────

  step++;
  emit(onEvent, step, totalSteps, 'running', 'Saving configuration...');
  const installedVersion = manifest.version ?? '';

  // Determine integration level
  const integration = manifest.integration || (manifest.type === 'native' ? 'native' : 'basic');

  const meta: InstallMetadata = {
    appId,
    integration: integration as 'native' | 'basic',
    subdomain: config.subdomain,
    domain: config.domain,
    enableSSO: ssoEnabled,
    installedAt: new Date().toISOString(),
    installedVersion,
    containers: containerMetas,
    ssoSlug,
    ssoClientId,
    manifestSource: config.repoUrl || 'appmarket',
  };
  await saveInstallMetadata(meta);

  try {
    await upsertInstalledApp({
      appId,
      type: integration,
      installedVersion,
      subdomain: config.subdomain,
      ssoSlug,
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
    await registerAppWithUI(appId, displayName, config.subdomain, primaryContainerName, primaryPort, displayIcon);
    emit(onEvent, step, totalSteps, 'success', 'Registered with dashboard');
  } catch (err) {
    emit(onEvent, step, totalSteps, 'success', `Dashboard registration skipped: ${err}`);
  }

  emit(onEvent, step, totalSteps, 'success', `${manifest.metadata.name} installed successfully!`);
}

// Re-export for backward compat
export { getContainerName } from './engine-helpers';
