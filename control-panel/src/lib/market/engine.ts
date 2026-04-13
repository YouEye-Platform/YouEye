/**
 * App Market deployment engine.
 * Generic YAML-driven installer that replaces per-app TypeScript functions.
 *
 * Follows this flow for ANY app based on its YAML manifest:
 * 1. Parse & validate manifest
 * 2. Generate secrets
 * 3. Setup shared PostgreSQL (if needed)
 * 4. Write config files (before container start)
 * 5. Deploy containers in order, wait for health
 * 6. Add Caddy reverse proxy route
 * 7. Configure SSO (if enabled)
 * 8. Save install metadata
 */

import type { OCIManifest } from '../infrastructure/types';
import type {
  AppManifest,
  ContainerSpec,
  InstallConfig,
  InstallEvent,
  InstallEventCallback,
  InstallMetadata,
  VariableContext,
  NativeConfig,
} from './types';
import { resolveVariables, resolveEnvironment } from './variables';
import { writeAllConfigFiles, applyLanguageToContainers } from './config-writer';
import { saveInstallMetadata } from './metadata';
import { upsertInstalledApp } from './installed-apps';
import { deployOCIContainer, getContainerIP } from '../infrastructure/oci-deployer';
import { deployLXDContainer } from '../infrastructure/lxd-deployer';
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
import { buildVariableContext, buildPlatformEnv, envToString } from './platform-env';
import { resolveConnectors } from './engine-connectors';

// ─── Container Naming ──────────────────────────────────────

/**
 * Get the Incus container name for a manifest container.
 * Single-container apps: app-{appId}
 * Multi-container apps: app-{appId}-{containerName}
 */
function getContainerName(appId: string, containerName: string, totalContainers: number): string {
  if (totalContainers === 1) {
    return `app-${appId}`;
  }
  return `app-${appId}-${containerName}`;
}

/**
 * Get the secrets app path for an app.
 */
function getSecretsPath(appId: string): string {
  return `app-${appId}`;
}

// ─── Step Counting ─────────────────────────────────────────

function countSteps(manifest: AppManifest, ssoEnabled: boolean): number {
  let steps = 0;
  steps++; // Generate secrets
  if (manifest.features.requiresSharedPostgres) steps++; // Setup shared postgres
  if (manifest.configFiles.length > 0) steps++; // Write config files

  if (manifest.native) {
    // Native LXD path
    steps++; // Deploy LXD container
    steps++; // Write env file + restart service
    if (manifest.native.healthCheck) steps++; // Health check
    if ((manifest.native.postDeploy?.length ?? 0) > 0) steps++; // Post-deploy commands
  } else {
    // OCI marketplace path
    steps += manifest.containers.length; // Deploy each container
    steps += manifest.containers.filter((c) => c.healthCheck).length; // Health checks
  }

  steps++; // Add Caddy route
  if (ssoEnabled && manifest.features.supportsSSO) steps++; // Create Authentik app (pre-deploy)
  if (ssoEnabled && manifest.features.supportsSSO && manifest.sso?.configure?.type !== 'none' && (manifest.sso?.configure?.steps?.length ?? 0) > 0) steps++; // Configure SSO (post-deploy)
  steps++; // Save metadata
  steps++; // Register with UI dashboard
  return steps;
}

// ─── Emit Helper ───────────────────────────────────────────

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

// ─── Route Helper ──────────────────────────────────────────

async function ensureRoute(params: Parameters<typeof addRoute>[0]): Promise<void> {
  try {
    await addRoute(params);
  } catch (err) {
    if (err instanceof Error && err.message.includes('already exists')) {
      return;
    }
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

/**
 * Register an installed marketplace app with YE-UI so it appears in the app drawer.
 */
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
  const containerUrl = port ? `http://${containerName}.incus:${port}` : `http://${containerName}.incus`;

  const res = await fetch(`http://${uiIP}:3000/api/v1/apps/register`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(bridgeToken ? { 'X-UI-Bridge-Token': bridgeToken } : {}),
    },
    body: JSON.stringify({
      id: appId,
      name,
      container_url: containerUrl,
      subdomain,
      icon,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.warn(`[engine] UI registration warning: ${res.status} ${text}`);
  }
}

// ─── Native LXD Deployment ────────────────────────────────

const GITEA_BASE = 'https://git.byka.wtf';
const GITEA_ORG = 'potemsla';

/**
 * Resolve the Gitea repo name from the native config repo field.
 * The repo field is "potemsla/YE-App-Wiki" format — extract the repo name.
 */
function giteaRepoFromNative(repo: string): string {
  const parts = repo.split('/');
  return parts[parts.length - 1];
}

/**
 * Write an env file to a native LXD container via base64-encoded exec.
 */
async function writeEnvToContainer(
  containerName: string,
  env: Record<string, string>,
): Promise<void> {
  const content = envToString(env);
  const b64 = Buffer.from(content).toString('base64');
  await execShell(
    containerName,
    `echo '${b64}' | base64 -d > /etc/${containerName}.env`,
    { timeout: 10_000 }
  );
}

/**
 * Deploy a native LXD container from manifest config.
 * Wraps lxd-deployer.ts with manifest-driven parameters.
 */
async function deployNativeLXDContainer(
  native: NativeConfig,
  manifest: AppManifest,
  config: InstallConfig,
  ctx: Partial<VariableContext>,
  onEvent: InstallEventCallback,
  currentStep: number,
  totalSteps: number,
): Promise<{ containerName: string; port: number; step: number }> {
  let step = currentStep;
  const containerName = native.containerName;

  // ── Deploy LXD container ──────────────────────────────
  step++;
  emit(onEvent, step, totalSteps, 'running', `Deploying ${containerName} (this takes several minutes)...`);
  try {
    await deployLXDContainer(
      {
        name: manifest.metadata.id,
        displayName: manifest.metadata.name,
        containerName,
        image: native.image,
        imageServer: native.imageServer || 'https://images.linuxcontainers.org',
        imageProtocol: 'simplestreams',
        nodeVersion: native.nodeVersion || '22.x',
        appDir: native.appDir || '/opt/app',
        port: native.port,
      },
      {
        spineSocketPath: '/var/run/spine/spine.sock',
        giteaBaseURL: GITEA_BASE,
        giteaOrg: GITEA_ORG,
        giteaRepo: giteaRepoFromNative(native.repo),
      }
    );
    emit(onEvent, step, totalSteps, 'success', `${containerName} deployed`);
  } catch (err) {
    emit(onEvent, step, totalSteps, 'error', `Failed to deploy ${containerName}`, String(err));
    throw err;
  }

  // ── Write env file + restart service ──────────────────
  step++;
  emit(onEvent, step, totalSteps, 'running', 'Writing configuration...');
  try {
    // Build platform env using unified builder
    const appId = manifest.metadata.id;
    const platformEnv = await buildPlatformEnv(
      {
        appId,
        subdomain: config.subdomain,
        domain: config.domain,
        port: native.port,
        sso: ctx.sso?.clientId ? { clientId: ctx.sso.clientId, clientSecret: ctx.sso.clientSecret } : undefined,
        jwtSecret: ctx.secrets?.jwt_secret,
      },
      manifest
    );

    // Resolve manifest-declared environment variables (DATABASE_URL, etc.)
    const manifestEnv = resolveEnvironment(native.environment ?? {}, ctx);

    // Resolve connector requirements (e.g., SEARCH_ENGINE_URL)
    const connectorEnv = await resolveConnectors(manifest);

    // Resolve installParams (e.g., TMDB_API_KEY for Cinema)
    // installParams are already in ctx.installParams and resolved via ${installParams.x} in manifestEnv

    // Merge: platform base + manifest-declared + connector-resolved
    const fullEnv = { ...platformEnv, ...manifestEnv, ...connectorEnv };

    await writeEnvToContainer(containerName, fullEnv);

    // Restart service to pick up new env
    await execShell(containerName, `systemctl restart ${containerName}`, { timeout: 15_000 });

    emit(onEvent, step, totalSteps, 'success', 'Configuration written');
  } catch (err) {
    emit(onEvent, step, totalSteps, 'error', 'Failed to write configuration', String(err));
    throw err;
  }

  // ── Post-deploy commands (if any) ─────────────────────
  if (native.postDeploy && native.postDeploy.length > 0) {
    step++;
    emit(onEvent, step, totalSteps, 'running', 'Running post-deploy commands...');
    try {
      for (const cmd of native.postDeploy) {
        await execShell(containerName, cmd.exec, { timeout: cmd.timeout });
      }
      emit(onEvent, step, totalSteps, 'success', 'Post-deploy commands completed');
    } catch (err) {
      emit(onEvent, step, totalSteps, 'error', 'Post-deploy command failed', String(err));
      throw err;
    }
  }

  // ── Health check ──────────────────────────────────────
  if (native.healthCheck) {
    step++;
    emit(onEvent, step, totalSteps, 'running', `Waiting for ${containerName} to be healthy...`);
    let healthy = false;
    if (native.healthCheck.type === 'http') {
      healthy = await waitForAppHealth(
        containerName,
        native.port,
        native.healthCheck.path,
        native.healthCheck.timeout
      );
    } else if (native.healthCheck.type === 'postgres') {
      healthy = await waitForPostgresHealth(
        containerName,
        native.healthCheck.user,
        native.healthCheck.timeout
      );
    }
    emit(
      onEvent, step, totalSteps,
      healthy ? 'success' : 'error',
      healthy ? `${containerName} is healthy` : `${containerName} health check timed out`
    );
  }

  return { containerName, port: native.port, step };
}

// ─── Main Install Function ─────────────────────────────────

/**
 * Install an app from a parsed YAML manifest.
 * Emits SSE progress events throughout the installation.
 * Accepts an optional AbortSignal to allow cancellation between steps.
 */
export async function installApp(
  manifest: AppManifest,
  config: InstallConfig,
  onEvent: InstallEventCallback,
  signal?: AbortSignal
): Promise<void> {
  const appId = manifest.metadata.id;
  const secretsPath = getSecretsPath(appId);
  const ssoEnabled = manifest.features.supportsSSO && (await isAuthentikAvailable());
  const totalSteps = countSteps(manifest, ssoEnabled);
  let step = 0;

  // Build variable context from unified platform-env builder.
  // Includes platform.*, authentik.*, smtp.* (if capability declared), etc.
  // Secrets, container IP, and SSO credentials are populated later in the flow.
  const ctx = await buildVariableContext(
    { appId, subdomain: config.subdomain, domain: config.domain },
    manifest
  );
  // Ensure secrets map exists for population below
  if (!ctx.secrets) ctx.secrets = {};

  // Populate installParams in context for ${installParams.x} variable resolution
  if (config.installParams) {
    ctx.installParams = config.installParams;
  }

  /** Throw if cancellation was requested */
  function checkCancelled() {
    if (signal?.aborted) {
      throw new Error('Installation cancelled by user');
    }
  }

  // ── Step 1: Generate secrets ──────────────────────────────

  checkCancelled();
  step++;
  emit(onEvent, step, totalSteps, 'running', 'Generating secrets...');
  for (const secret of manifest.secrets) {
    const generator = getGenerator(secret.generator, secret.length);
    const value = await getOrCreateSecret(secretsPath, secret.file, generator);
    ctx.secrets![secret.name] = value;
  }
  emit(onEvent, step, totalSteps, 'success', 'Secrets generated');

  // ── Step 2: Setup shared PostgreSQL (if needed) ───────────

  if (manifest.features.requiresSharedPostgres && manifest.sharedPostgres) {
    checkCancelled();
    step++;
    emit(onEvent, step, totalSteps, 'running', 'Setting up shared database...');
    try {
      await setupSharedPostgres(manifest.sharedPostgres, ctx);
      emit(onEvent, step, totalSteps, 'success', 'Database ready');
    } catch (err) {
      emit(onEvent, step, totalSteps, 'error', 'Failed to setup database', String(err));
      throw err;
    }
  }

  // ── Step 3: Write config files ────────────────────────────

  if (manifest.configFiles.length > 0) {
    checkCancelled();
    step++;
    emit(onEvent, step, totalSteps, 'running', 'Writing configuration files...');
    try {
      await writeAllConfigFiles(manifest.configFiles, ctx);
      emit(onEvent, step, totalSteps, 'success', 'Configuration files written');
    } catch (err) {
      emit(onEvent, step, totalSteps, 'error', 'Failed to write config files', String(err));
      throw err;
    }
  }

  // ── Step 3b: Inject language env var if manifest specifies it ──
  // Uses config-writer's applyLanguageToContainers which reads language.env_var
  // and language.format from the manifest.

  if (manifest.language) {
    const systemLang = await getSystemLanguageForApps();
    applyLanguageToContainers(manifest, systemLang);
  }

  // ── Step 4a: Pre-deploy SSO — create Authentik app early ──
  // Apps that configure SSO via env vars (Vaultwarden, Paperless, etc.)
  // need ${sso.clientId} and ${sso.clientSecret} resolved at container
  // deploy time. Create the Authentik OAuth2 app now so those variables
  // are available. The SSO *configure* steps (HTTP API calls to the app
  // itself) still run after containers are healthy.

  let ssoSlug: string | undefined;
  let ssoClientId: string | undefined;

  if (ssoEnabled && manifest.sso) {
    checkCancelled();
    step++;
    emit(onEvent, step, totalSteps, 'running', 'Creating Authentik SSO application...');
    try {
      ssoSlug = resolveVariables(manifest.sso.authentikSlug, ctx);
      const appUrl = `https://${config.subdomain}.${config.domain}`;

      const redirectUris = manifest.sso.redirectUris.map((r) => ({
        matching_mode: 'strict' as const,
        url: resolveVariables(r.url, ctx),
      }));

      const ssoResult = await createAuthentikOAuth2App({
        slug: ssoSlug,
        name: manifest.metadata.name,
        redirectUris,
        launchUrl: appUrl,
        implicitConsent: true,
      });

      ssoClientId = ssoResult.clientId;
      ctx.sso = { clientId: ssoResult.clientId, clientSecret: ssoResult.clientSecret };

      emit(onEvent, step, totalSteps, 'success', 'Authentik SSO application created');
    } catch (err) {
      emit(onEvent, step, totalSteps, 'error', 'Failed to create SSO application', String(err));
      throw err;
    }
  }

  // ── Step 4b: Deploy containers ─────────────────────────────

  const containerNames: string[] = [];
  let primaryContainerName = '';
  let primaryPort = 0;

  if (manifest.native) {
    // ── Native LXD deployment path ──────────────────────────
    checkCancelled();
    const result = await deployNativeLXDContainer(
      manifest.native, manifest, config, ctx, onEvent, step, totalSteps,
    );
    primaryContainerName = result.containerName;
    primaryPort = result.port;
    containerNames.push(result.containerName);
    step = result.step;
  } else {
    // ── OCI marketplace deployment path ─────────────────────
    for (const containerSpec of manifest.containers) {
      const containerName = getContainerName(appId, containerSpec.name, manifest.containers.length);
      containerNames.push(containerName);

      const isPrimary =
        containerSpec.primary || (manifest.containers.length === 1);

      if (isPrimary) {
        primaryContainerName = containerName;
        primaryPort = containerSpec.port || 0;
      }

      // Deploy container
      checkCancelled();
      step++;
      emit(onEvent, step, totalSteps, 'running', `Deploying ${containerName}...`);
      try {
        const ociManifest = buildOCIManifest(containerSpec, containerName, appId, ctx);
        await deployOCIContainer(ociManifest, '');
        emit(onEvent, step, totalSteps, 'success', `${containerName} created`);
      } catch (err) {
        emit(onEvent, step, totalSteps, 'error', `Failed to deploy ${containerName}`, String(err));
        throw err;
      }

      // Health check (if defined)
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

        emit(
          onEvent,
          step,
          totalSteps,
          healthy ? 'success' : 'error',
          healthy ? `${containerName} is healthy` : `${containerName} health check timed out`
        );
      }
    }
  }

  // ── Step 5: SSO Configure Steps ───────────────────────────
  // Authentik app was already created in Step 4a. Now run the app-side
  // SSO configuration (HTTP API calls to the running container).

  if (ssoEnabled && manifest.sso && manifest.sso.configure.type !== 'none' && manifest.sso.configure.steps.length > 0) {
    checkCancelled();
    // Get primary container IP for SSO configuration
    const primaryIP = await getContainerIP(primaryContainerName);
    if (primaryIP) {
      ctx.container = { ip: primaryIP, port: primaryPort };
    }

    step++;
    emit(onEvent, step, totalSteps, 'running', `Configuring ${manifest.metadata.name} SSO...`);
    try {
      await executeSSOSteps(manifest.sso, ctx);
      emit(onEvent, step, totalSteps, 'success', `${manifest.metadata.name} SSO configured`);
    } catch (err) {
      emit(onEvent, step, totalSteps, 'error', 'SSO configuration failed', String(err));
      throw err;
    }
  }

  // ── Step 6: Add Caddy route ───────────────────────────────

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

  // ── Step 7: Save metadata ────────────────────────────────

  step++;
  emit(onEvent, step, totalSteps, 'running', 'Saving configuration...');
  const installedVersion = manifest.version ?? '';
  const meta: InstallMetadata = {
    appId,
    type: manifest.type ?? 'marketplace',
    subdomain: config.subdomain,
    domain: config.domain,
    enableSSO: ssoEnabled,
    installedAt: new Date().toISOString(),
    installedVersion,
    containers: containerNames,
    ssoSlug,
    ssoClientId,
  };
  await saveInstallMetadata(meta);

  // Track in installed_apps DB table for version management
  try {
    await upsertInstalledApp({
      appId,
      type: manifest.type ?? 'marketplace',
      installedVersion,
      subdomain: config.subdomain,
      ssoSlug,
    });
  } catch (err) {
    console.error('[engine] Failed to track installed app in DB:', err);
    // Non-fatal — install.json is the fallback
  }

  emit(onEvent, step, totalSteps, 'success', 'Configuration saved');

  // ── Step 8: Register with YE-UI dashboard ────────────────

  step++;
  emit(onEvent, step, totalSteps, 'running', 'Registering with dashboard...');
  try {
    // Use custom name/icon from install config if provided, otherwise fall back to manifest
    const displayName = config.customName || manifest.metadata.name;
    const displayIcon = config.customIcon || manifest.metadata.iconUrl || manifest.metadata.icon || null;
    await registerAppWithUI(
      appId,
      displayName,
      config.subdomain,
      primaryContainerName,
      primaryPort,
      displayIcon,
    );
    emit(onEvent, step, totalSteps, 'success', 'Registered with dashboard');
  } catch (err) {
    // Non-fatal — app still works, just won't appear in the drawer until manually registered
    emit(onEvent, step, totalSteps, 'success', `Dashboard registration skipped: ${err}`);
  }

  emit(onEvent, step, totalSteps, 'success', `${manifest.metadata.name} installed successfully!`);
}

// ─── Helpers ───────────────────────────────────────────────

/**
 * Build an OCIManifest from a YAML container spec.
 */
function buildOCIManifest(
  spec: ContainerSpec,
  containerName: string,
  appId: string,
  ctx: Partial<VariableContext>
): OCIManifest {
  // Resolve volume host paths
  const volumes = spec.volumes.map((v) => ({
    host: resolveVariables(v.host, ctx),
    container: v.container,
  }));

  // Resolve environment variables
  const environment = resolveEnvironment(spec.environment, ctx);

  return {
    name: appId,
    displayName: containerName,
    image: spec.image,
    containerName,
    command: spec.command,
    ports: [], // Market apps don't use host port proxies — they use Caddy
    environment,
    volumes,
    limits: spec.limits ? {
      memory: spec.limits.memory,
      cpu: spec.limits.cpu,
    } : undefined,
  };
}

/**
 * Get a secret generator function by type.
 */
function getGenerator(type: string, length: number): () => string {
  switch (type) {
    case 'password':
      return () => generatePassword(length);
    case 'secretKey':
      return () => generateSecretKey(length);
    case 'hexToken':
      return () => generateHexToken(length);
    default:
      return () => generatePassword(length);
  }
}

/**
 * Read the system language via the platform context cache.
 * Falls back to "en" if unavailable.
 */
async function getSystemLanguageForApps(): Promise<string> {
  const { getPlatformContext } = await import('./platform-env');
  const platform = await getPlatformContext();
  return platform.locale || 'en';
}

/**
 * Setup a database and user in the shared PostgreSQL instance.
 */
async function setupSharedPostgres(
  spec: { database: string; user: string; password: string },
  ctx: Partial<VariableContext>
): Promise<void> {
  const { execShell } = await import('../incus/server');
  const dbName = spec.database;
  const dbUser = spec.user;
  const dbPassword = resolveVariables(spec.password, ctx);

  const POSTGRES_CONTAINER = 'youeye-postgres';

  // Check if user exists
  const checkUser = await execShell(
    POSTGRES_CONTAINER,
    `psql -U youeye -tAc "SELECT 1 FROM pg_roles WHERE rolname='${dbUser}'"`,
    { timeout: 10_000 }
  );

  if (!checkUser.stdout.includes('1')) {
    const result = await execShell(
      POSTGRES_CONTAINER,
      `psql -U youeye -c "CREATE USER ${dbUser} WITH PASSWORD '${dbPassword}'"`,
      { timeout: 10_000 }
    );
    if (result.exitCode !== 0) {
      throw new Error(`Failed to create user ${dbUser}: ${result.stderr}`);
    }
  } else {
    // User exists — update password to match the new generated one
    const result = await execShell(
      POSTGRES_CONTAINER,
      `psql -U youeye -c "ALTER USER ${dbUser} WITH PASSWORD '${dbPassword}'"`,
      { timeout: 10_000 }
    );
    if (result.exitCode !== 0) {
      throw new Error(`Failed to update password for ${dbUser}: ${result.stderr}`);
    }
  }

  // Check if database exists
  const checkDB = await execShell(
    POSTGRES_CONTAINER,
    `psql -U youeye -tAc "SELECT 1 FROM pg_database WHERE datname='${dbName}'"`,
    { timeout: 10_000 }
  );

  if (checkDB.stdout.includes('1')) {
    // Database exists — drop and recreate for a clean install.
    // All installs are fresh (the engine uninstalls first if metadata exists),
    // so an existing DB here means stale data from a manual cleanup.
    await execShell(
      POSTGRES_CONTAINER,
      `psql -U youeye -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${dbName}' AND pid <> pg_backend_pid();"`,
      { timeout: 10_000 }
    );
    const dropResult = await execShell(
      POSTGRES_CONTAINER,
      `psql -U youeye -c "DROP DATABASE ${dbName}"`,
      { timeout: 10_000 }
    );
    if (dropResult.exitCode !== 0) {
      throw new Error(`Failed to drop stale database ${dbName}: ${dropResult.stderr}`);
    }
  }

  const createResult = await execShell(
    POSTGRES_CONTAINER,
    `psql -U youeye -c "CREATE DATABASE ${dbName} OWNER ${dbUser}"`,
    { timeout: 10_000 }
  );
  if (createResult.exitCode !== 0) {
    throw new Error(`Failed to create database ${dbName}: ${createResult.stderr}`);
  }
}
