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
} from './types';
import { resolveVariables, resolveEnvironment } from './variables';
import { writeAllConfigFiles, applyLanguageToContainers } from './config-writer';
import { saveInstallMetadata } from './metadata';
import { upsertInstalledApp } from './installed-apps';
import { deployOCIContainer, getContainerIP } from '../infrastructure/oci-deployer';
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
  getAuthentikExternalUrl,
  createAuthentikOAuth2App,
  executeSSOSteps,
} from './sso-engine';
import { getContainerIP as getIncusContainerIP } from '../incus/container-ip';

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
  steps += manifest.containers.length; // Deploy each container
  // Health checks for containers that have them
  steps += manifest.containers.filter((c) => c.healthCheck).length;
  steps++; // Add Caddy route
  if (ssoEnabled && manifest.features.supportsSSO) steps += 2; // Create Authentik app + configure SSO
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

  // Build initial variable context (secrets get added after generation)
  const ctx: Partial<VariableContext> = {
    app: { id: appId },
    install: {
      url: `https://${config.subdomain}.${config.domain}`,
      subdomain: config.subdomain,
      domain: config.domain,
    },
    secrets: {},
    container: { ip: '', port: 0 },
    sso: { clientId: '', clientSecret: '' },
    authentik: { externalUrl: '', internalUrl: '', name: '' },
  };

  // Populate SMTP context if the app declares smtp capability
  if (manifest.capabilities?.smtp) {
    try {
      const { settingsService } = await import('../settings');
      const { readSmtpPassword } = await import('../smtp/secrets');
      const settings = await settingsService.getAll();
      const smtpPassword = await readSmtpPassword();
      const smtpConfigured = !!(settings.smtpHost && smtpPassword);

      ctx.smtp = {
        host: settings.smtpHost || '',
        port: String(settings.smtpPort || 587),
        username: settings.smtpUsername || '',
        password: smtpPassword,
        from: settings.smtpFrom || '',
        tls: String(settings.smtpRequireTls ?? true),
        configured: String(smtpConfigured),
      };
    } catch {
      // SMTP not configured — leave ctx.smtp undefined
    }
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

  // ── Step 4: Deploy containers in order ────────────────────

  const containerNames: string[] = [];
  let primaryContainerName = '';
  let primaryPort = 0;

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

  // ── Step 5: SSO Setup ─────────────────────────────────────

  let ssoSlug: string | undefined;
  let ssoClientId: string | undefined;

  if (ssoEnabled && manifest.sso) {
    checkCancelled();
    // Get primary container IP for SSO configuration
    const primaryIP = await getContainerIP(primaryContainerName);
    if (primaryIP) {
      ctx.container = { ip: primaryIP, port: primaryPort };
    }

    // Get Authentik URLs
    const authentikExternalUrl = await getAuthentikExternalUrl();
    const authentikIP = await getIncusContainerIP('youeye-authentik');
    const authentikInternalUrl = authentikIP ? `http://${authentikIP}:9000` : authentikExternalUrl || '';

    // Read authentik_name from config for the variable resolver
    let authentikDisplayName = '';
    try {
      const platformConfig = await getSystemConfig();
      authentikDisplayName = String(platformConfig.authentik_name || '') || `${String(platformConfig.site_name || 'YouEye')} ID`;
    } catch {
      authentikDisplayName = '';
    }

    ctx.authentik = {
      externalUrl: authentikExternalUrl || '',
      internalUrl: authentikInternalUrl,
      name: authentikDisplayName,
    };

    // Create Authentik OAuth2 app
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
        // Use implicit consent to avoid BUG-004 consent screen friction
        implicitConsent: true,
      });

      ssoClientId = ssoResult.clientId;
      ctx.sso = { clientId: ssoResult.clientId, clientSecret: ssoResult.clientSecret };

      emit(onEvent, step, totalSteps, 'success', 'Authentik SSO application created');
    } catch (err) {
      emit(onEvent, step, totalSteps, 'error', 'Failed to create SSO application', String(err));
      throw err;
    }

    // Configure app SSO via HTTP API steps
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
    limits: {
      memory: spec.limits.memory,
      cpu: spec.limits.cpu,
    },
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
 * Read the system config from youeye.yaml via Spine API.
 * Returns parsed config object. Falls back to empty object.
 */
async function getSystemConfig(): Promise<Record<string, unknown>> {
  try {
    const http = await import('http');
    return await new Promise<Record<string, unknown>>((resolve) => {
      const req = http.request(
        {
          socketPath: '/var/run/spine/spine.sock',
          path: '/api/config',
          method: 'GET',
          headers: { 'Content-Type': 'application/json' },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk: Buffer) => (data += chunk));
          res.on('end', () => {
            try {
              resolve(JSON.parse(data));
            } catch {
              resolve({});
            }
          });
        }
      );
      req.on('error', () => resolve({}));
      req.setTimeout(5000, () => {
        req.destroy();
        resolve({});
      });
      req.end();
    });
  } catch {
    return {};
  }
}

/**
 * Read the system language from youeye.yaml via Spine API.
 * Falls back to "en" if unavailable.
 */
async function getSystemLanguageForApps(): Promise<string> {
  const config = await getSystemConfig();
  return (config.language as string) || 'en';
}

/**
 * Convert a language code to the format expected by the app.
 * - "iso639": returns as-is (e.g. "en", "ru", "es")
 * - "full": returns the full English name (e.g. "english", "russian")
 */
function formatLanguageValue(lang: string, format: string): string {
  if (format === 'full') {
    const langNames: Record<string, string> = {
      en: 'english',
      ru: 'russian',
      es: 'spanish',
      de: 'german',
      fr: 'french',
    };
    return langNames[lang] || 'english';
  }
  return lang;
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
