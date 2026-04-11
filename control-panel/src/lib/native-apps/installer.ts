/**
 * Native app installer.
 * Handles install/uninstall of YouEye native apps (wiki, search, notes).
 * These are LXD containers deployed from Gitea releases, unlike marketplace OCI apps.
 *
 * Install flow for wiki:
 * 1. Generate JWT secret
 * 2. Create Authentik OAuth2 app (need creds for env file)
 * 3. Deploy LXD container (downloads app from Gitea, installs Node.js, starts service)
 * 4. Write env file with Authentik credentials
 * 5. Restart service to pick up env vars
 * 6. Wait for health check
 * 7. Add Caddy reverse proxy route
 */

import { existsSync } from 'fs';
import { deployLXDContainer } from '@/lib/infrastructure/lxd-deployer';
import { containerExists } from '@/lib/infrastructure/oci-deployer';
import { incusRequest, execShell } from '@/lib/incus/server';
import {
  createAuthentikOAuth2App,
  removeAuthentikOAuth2App,
  getAuthentikExternalUrl,
} from '@/lib/market/authentik';
import { addRoute, getRoutes, removeRoute, ensurePingRoute } from '@/lib/caddy/client';
import { generateSecretKey, generatePassword } from '@/lib/infrastructure/secrets';
import { getContainerIP } from '@/lib/incus/container-ip';
import type { InstallEvent, InstallEventCallback, InstallMetadata } from '@/lib/market/types';
import { saveInstallMetadata, readInstallMetadata } from '@/lib/market/metadata';
import { getAllInstalledApps } from '@/lib/market/installed-apps';
import { nativeContainerName, nativeGiteaRepo } from './catalog';

const GITEA_BASE = 'https://git.byka.wtf';
const GITEA_ORG = 'potemsla';

// ─── Public Types ──────────────────────────────────────────

export interface NativeInstallConfig {
  appId: string;
  subdomain: string;
  domain: string;
  /** Custom display name chosen by user at install time */
  customName?: string;
  /** Custom icon chosen by user at install time */
  customIcon?: string;
  /** Optional app-specific install params (e.g. TMDB API key for Cinema) */
  installParams?: Record<string, string>;
}

// ─── Search Engine Detection ──────────────────────────────

interface DetectedSearchEngine {
  type: 'whoogle' | 'searxng';
  containerName: string;
  port: number;
  url: string;
}

/**
 * Detect an installed search engine (Whoogle or SearXNG).
 * Checks both the installed_apps DB table and install.json metadata.
 * Returns the engine config needed for SEARCH_ENGINE_URL / SEARCH_ENGINE_TYPE.
 */
async function detectSearchEngine(): Promise<DetectedSearchEngine | null> {
  // Check installed_apps DB table first
  try {
    const installedApps = await getAllInstalledApps();

    for (const app of installedApps) {
      if (app.appId === 'whoogle') {
        const containerName = 'app-whoogle';
        return {
          type: 'whoogle',
          containerName,
          port: 5000,
          url: `http://${containerName}.incus:5000`,
        };
      }
      if (app.appId === 'searxng') {
        const containerName = 'app-searxng';
        return {
          type: 'searxng',
          containerName,
          port: 8080,
          url: `http://${containerName}.incus:8080`,
        };
      }
    }
  } catch {
    // DB not available — fall through to metadata check
  }

  // Check install.json metadata as fallback
  const whoogleMeta = await readInstallMetadata('whoogle');
  if (whoogleMeta) {
    const containerName = whoogleMeta.containers?.[0] ?? 'app-whoogle';
    return {
      type: 'whoogle',
      containerName,
      port: 5000,
      url: `http://${containerName}.incus:5000`,
    };
  }

  const searxngMeta = await readInstallMetadata('searxng');
  if (searxngMeta) {
    const containerName = searxngMeta.containers?.[0] ?? 'app-searxng';
    return {
      type: 'searxng',
      containerName,
      port: 8080,
      url: `http://${containerName}.incus:8080`,
    };
  }

  // Last resort: probe Incus directly for container existence
  for (const name of ['app-whoogle', 'app-whoogle-main']) {
    if (await containerExists(name)) {
      return { type: 'whoogle', containerName: name, port: 5000, url: `http://${name}.incus:5000` };
    }
  }
  for (const name of ['app-searxng', 'app-searxng-main']) {
    if (await containerExists(name)) {
      return { type: 'searxng', containerName: name, port: 8080, url: `http://${name}.incus:8080` };
    }
  }

  return null;
}

// ─── Dashboard Registration ──────────────────────────────

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
  icon: string,
  onEvent: InstallEventCallback,
  step: number,
  totalSteps: number
): Promise<void> {
  emit(onEvent, step, totalSteps, 'running', `Registering ${name} with dashboard...`);
  try {
    const uiIP = await getContainerIP('youeye-ui');
    if (!uiIP) {
      emit(onEvent, step, totalSteps, 'success', 'Dashboard registration skipped (UI unreachable)');
      return;
    }

    const bridgeToken = await readBridgeToken();
    const containerUrl = `http://${containerName}.incus:3000`;

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
      emit(onEvent, step, totalSteps, 'success', `Dashboard registration warning: ${res.status} ${text}`);
      return;
    }

    emit(onEvent, step, totalSteps, 'success', `Registered ${name} with dashboard`);
  } catch (err) {
    // Non-fatal — app still works, just won't appear in drawer/widgets until manually registered
    emit(onEvent, step, totalSteps, 'success', `Dashboard registration skipped: ${err}`);
  }
}

async function deregisterAppFromUI(appId: string): Promise<void> {
  try {
    const uiIP = await getContainerIP('youeye-ui');
    if (!uiIP) return;
    const bridgeToken = await readBridgeToken();
    await fetch(`http://${uiIP}:3000/api/v1/apps/${appId}/unregister`, {
      method: 'DELETE',
      headers: bridgeToken ? { 'X-UI-Bridge-Token': bridgeToken } : {},
    });
  } catch { /* non-fatal */ }
}

// ─── Reinstall Detection ──────────────────────────────────

/**
 * Check if an app was previously installed with keepData=true.
 * When uninstall preserves data, the metadata directory remains at
 * /var/lib/youeye/app-{appId}/ with install.json.
 * Returns the previous install metadata if found.
 */
async function detectPreviousInstall(appId: string): Promise<InstallMetadata | null> {
  // appId here is the metadata appId (e.g. 'wiki', 'search') not the full 'ye-wiki'
  const meta = await readInstallMetadata(appId);
  return meta;
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

// ─── Status Check ──────────────────────────────────────────

export async function getNativeAppStatus(
  appIdInput: string
): Promise<'running' | 'stopped' | 'not-installed'> {
  const containerName = nativeContainerName(appIdInput);
  if (!(await containerExists(containerName))) return 'not-installed';

  try {
    const resp = await incusRequest<{ status?: string }>(
      'GET',
      `/1.0/instances/${containerName}/state`
    );
    const status = resp.metadata?.status?.toLowerCase();
    return status === 'running' ? 'running' : 'stopped';
  } catch {
    return 'stopped';
  }
}

// ─── Main Install Entry Point ──────────────────────────────

export async function installNativeApp(
  config: NativeInstallConfig,
  onEvent: InstallEventCallback
): Promise<void> {
  if (config.appId === 'ye-wiki') {
    return installWiki(config, onEvent);
  }
  if (config.appId === 'ye-search') {
    return installSearch(config, onEvent);
  }
  if (config.appId === 'ye-notes') {
    return installNotes(config, onEvent);
  }
  if (config.appId === 'ye-cinema') {
    return installCinema(config, onEvent);
  }
  if (config.appId === 'ye-weather') {
    return installWeather(config, onEvent);
  }
  if (config.appId === 'ye-translate') {
    return installTranslate(config, onEvent);
  }
  throw new Error(`Native app installer not implemented for: ${config.appId}`);
}

// ─── Wiki Installer ────────────────────────────────────────

async function installWiki(
  config: NativeInstallConfig,
  onEvent: InstallEventCallback
): Promise<void> {
  const TOTAL_STEPS = 9;
  const containerName = 'ye-app-wiki';
  const appUrl = `https://${config.subdomain}.${config.domain}`;

  // Check for previous install data (reinstall after keepData=true)
  const previousInstall = await detectPreviousInstall('wiki');
  if (previousInstall) {
    emit(onEvent, 0, TOTAL_STEPS, 'running', 'Restoring existing app data — reinstall detected');
  }

  // ── Step 1: Generate secrets ──────────────────────────────
  emit(onEvent, 1, TOTAL_STEPS, 'running', 'Generating secrets...');
  const jwtSecret = generateSecretKey(64);
  emit(onEvent, 1, TOTAL_STEPS, 'success', 'Secrets generated');

  // ── Step 2: Create Authentik OAuth2 app ───────────────────
  // Do this before container deploy so we have credentials for the env file.
  emit(onEvent, 2, TOTAL_STEPS, 'running', 'Creating SSO application in Authentik...');
  let clientId = 'ye-wiki';
  let clientSecret = '';
  try {
    const ssoResult = await createAuthentikOAuth2App({
      slug: 'ye-wiki',
      name: 'Wiki',
      redirectUris: [{ matching_mode: 'strict', url: `${appUrl}/api/auth/callback` }],
      launchUrl: appUrl,
      implicitConsent: true,
    });
    clientId = ssoResult.clientId;
    clientSecret = ssoResult.clientSecret;
    emit(onEvent, 2, TOTAL_STEPS, 'success', 'Authentik SSO application created');
  } catch (err) {
    emit(onEvent, 2, TOTAL_STEPS, 'error', 'Failed to create SSO application', String(err));
    throw err;
  }

  // Wrap remaining steps so we clean up the SSO app on failure
  try {

  // ── Step 3: Deploy LXD container ─────────────────────────
  emit(onEvent, 3, TOTAL_STEPS, 'running', 'Deploying Wiki container (this takes several minutes)...');
  try {
    await deployLXDContainer(
      {
        name: 'ye-wiki',
        displayName: 'Wiki',
        containerName,
        image: 'debian/12',
        imageServer: 'https://images.linuxcontainers.org',
        imageProtocol: 'simplestreams',
        nodeVersion: '22.x',
        appDir: '/opt/app',
        port: 3000,
      },
      {
        spineSocketPath: '/var/run/spine/spine.sock',
        giteaBaseURL: GITEA_BASE,
        giteaOrg: GITEA_ORG,
        giteaRepo: nativeGiteaRepo(config.appId),
      }
    );
    emit(onEvent, 3, TOTAL_STEPS, 'success', 'Wiki container deployed');
  } catch (err) {
    emit(onEvent, 3, TOTAL_STEPS, 'error', 'Container deployment failed', String(err));
    throw err;
  }

  // ── Step 4: Write env file ────────────────────────────────
  emit(onEvent, 4, TOTAL_STEPS, 'running', 'Writing configuration...');
  try {
    // Get Authentik URLs
    const authExternalUrl = await getAuthentikExternalUrl();
    if (!authExternalUrl) {
      throw new Error('Could not determine Authentik external URL from Caddy config. Ensure Authentik is running and has a Caddy route configured.');
    }
    const authUrl = authExternalUrl;
    const authentikIP = await getContainerIP('youeye-authentik');
    const authentikInternalUrl = authentikIP
      ? `http://${authentikIP}:9000`
      : 'http://youeye-authentik.incus:9000';

    // Derive UI base URL from domain (root domain = UI)
    const uiBaseUrl = `https://${config.domain}`;

    const envContent = [
      'NODE_ENV=production',
      'PORT=3000',
      'HOSTNAME=0.0.0.0',
      `AUTHENTIK_URL=${authUrl}`,
      `AUTHENTIK_INTERNAL_URL=${authentikInternalUrl}`,
      `AUTHENTIK_CLIENT_ID=${clientId}`,
      `AUTHENTIK_CLIENT_SECRET=${clientSecret}`,
      `JWT_SECRET=${jwtSecret}`,
      `WIKI_EXTERNAL_URL=${appUrl}`,
      `NEXT_PUBLIC_APP_URL=${appUrl}`,
      'YOUEYE_API_URL=http://youeye-ui.incus:3000/api/v1',
      `YOUEYE_UI_URL=${uiBaseUrl}`,
      'SECURE_COOKIES=false',
    ].join('\n') + '\n'; // BUG-023: Ensure trailing newline

    // Write via base64 to avoid shell quoting issues with special characters in secrets
    const b64 = Buffer.from(envContent).toString('base64');
    await execShell(
      containerName,
      `echo '${b64}' | base64 -d > /etc/${containerName}.env`,
      { timeout: 10_000 }
    );

    // Restart service to pick up the new env vars
    await execShell(containerName, `systemctl restart ${containerName}`, { timeout: 20_000 });
    emit(onEvent, 4, TOTAL_STEPS, 'success', 'Configuration written and service restarted');
  } catch (err) {
    emit(onEvent, 4, TOTAL_STEPS, 'error', 'Failed to write configuration', String(err));
    throw err;
  }

  // ── Step 5: Health check ──────────────────────────────────
  emit(onEvent, 5, TOTAL_STEPS, 'running', 'Waiting for Wiki to be healthy...');
  let healthy = false;
  for (let i = 0; i < 30; i++) {
    try {
      const result = await execShell(
        containerName,
        'curl -sf http://localhost:3000/api/health',
        { timeout: 5000 }
      );
      if (result.exitCode === 0) {
        healthy = true;
        break;
      }
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  emit(
    onEvent,
    5,
    TOTAL_STEPS,
    healthy ? 'success' : 'error',
    healthy ? 'Wiki is healthy' : 'Wiki health check timed out (may still be starting)'
  );

  // ── Step 6: Add Caddy route ───────────────────────────────
  emit(onEvent, 6, TOTAL_STEPS, 'running', 'Configuring reverse proxy...');
  try {
    await addRoute({
      hostname: `${config.subdomain}.${config.domain}`,
      path: '/*',
      upstream: containerName,
      port: 3000,
    });
    emit(onEvent, 6, TOTAL_STEPS, 'success', `Route added: ${config.subdomain}.${config.domain}`);
  } catch (err) {
    const msg = String(err);
    if (msg.toLowerCase().includes('already exists')) {
      emit(onEvent, 6, TOTAL_STEPS, 'success', 'Caddy route already configured');
    } else {
      emit(onEvent, 6, TOTAL_STEPS, 'error', 'Failed to configure reverse proxy', msg);
      throw err;
    }
  }

  // ── Step 7: Ensure ping route ────────────────────────────
  try { await ensurePingRoute('youeye-control', 3000); } catch { /* non-fatal */ }

  // ── Step 8: Register with dashboard ─────────────────────
  await registerAppWithUI('ye-wiki', config.customName || 'Wiki', config.subdomain, containerName, config.customIcon || 'BookOpen', onEvent, 7, TOTAL_STEPS);

  // ── Step 9: Save metadata + Done ─────────────────────────
  const meta: InstallMetadata = {
    appId: 'wiki',
    type: 'native',
    subdomain: config.subdomain,
    domain: config.domain,
    enableSSO: true,
    installedAt: new Date().toISOString(),
    containers: [containerName],
    ssoSlug: 'ye-wiki',
    ssoClientId: clientId,
  };
  await saveInstallMetadata(meta);
  emit(onEvent, 9, TOTAL_STEPS, 'success', 'Wiki installed successfully!');

  } catch (err) {
    // Rollback: remove orphaned Authentik SSO app
    try { await removeAuthentikOAuth2App('ye-wiki'); } catch { /* best-effort */ }
    throw err;
  }
}

// ─── Search Installer ──────────────────────────────────────

async function installSearch(
  config: NativeInstallConfig,
  onEvent: InstallEventCallback
): Promise<void> {
  const TOTAL_STEPS = 10;
  const containerName = 'ye-app-search';
  const appUrl = `https://${config.subdomain}.${config.domain}`;

  // Check for previous install data (reinstall after keepData=true)
  const previousInstall = await detectPreviousInstall('search');
  if (previousInstall) {
    emit(onEvent, 0, TOTAL_STEPS, 'running', 'Restoring existing app data — reinstall detected');
  }

  // ── Step 1: Detect or install search engine dependency ────
  emit(onEvent, 1, TOTAL_STEPS, 'running', 'Detecting search engine backend...');
  let engine = await detectSearchEngine();
  if (!engine) {
    emit(onEvent, 1, TOTAL_STEPS, 'running', 'No search engine found — Whoogle will be installed as a dependency');
    engine = {
      type: 'whoogle',
      containerName: 'app-whoogle',
      port: 5000,
      url: 'http://app-whoogle.incus:5000',
    };
    emit(onEvent, 1, TOTAL_STEPS, 'success', 'Whoogle dependency noted — install it from App Market to enable search');
  } else {
    emit(onEvent, 1, TOTAL_STEPS, 'success', `Detected ${engine.type} at ${engine.containerName}`);
  }

  // ── Step 2: Generate secrets ──────────────────────────────
  emit(onEvent, 2, TOTAL_STEPS, 'running', 'Generating secrets...');
  const jwtSecret = generateSecretKey(64);
  emit(onEvent, 2, TOTAL_STEPS, 'success', 'Secrets generated');

  // ── Step 3: Create Authentik OAuth2 app ───────────────────
  emit(onEvent, 3, TOTAL_STEPS, 'running', 'Creating SSO application in Authentik...');
  let clientId = 'ye-search';
  let clientSecret = '';
  try {
    const ssoResult = await createAuthentikOAuth2App({
      slug: 'ye-search',
      name: 'Search',
      redirectUris: [{ matching_mode: 'strict', url: `${appUrl}/api/auth/callback` }],
      launchUrl: appUrl,
      implicitConsent: true,
    });
    clientId = ssoResult.clientId;
    clientSecret = ssoResult.clientSecret;
    emit(onEvent, 3, TOTAL_STEPS, 'success', 'Authentik SSO application created');
  } catch (err) {
    emit(onEvent, 3, TOTAL_STEPS, 'error', 'Failed to create SSO application', String(err));
    throw err;
  }

  // Wrap remaining steps so we clean up the SSO app on failure
  try {

  // ── Step 4: Deploy LXD container ─────────────────────────
  emit(onEvent, 4, TOTAL_STEPS, 'running', 'Deploying Search container (this takes several minutes)...');
  try {
    await deployLXDContainer(
      {
        name: 'ye-search',
        displayName: 'Search',
        containerName,
        image: 'debian/12',
        imageServer: 'https://images.linuxcontainers.org',
        imageProtocol: 'simplestreams',
        nodeVersion: '22.x',
        appDir: '/opt/app',
        port: 3000,
      },
      {
        spineSocketPath: '/var/run/spine/spine.sock',
        giteaBaseURL: GITEA_BASE,
        giteaOrg: GITEA_ORG,
        giteaRepo: nativeGiteaRepo(config.appId),
      }
    );
    emit(onEvent, 4, TOTAL_STEPS, 'success', 'Search container deployed');
  } catch (err) {
    emit(onEvent, 4, TOTAL_STEPS, 'error', 'Container deployment failed', String(err));
    throw err;
  }

  // ── Step 5: Write env file (with search engine config) ────
  emit(onEvent, 5, TOTAL_STEPS, 'running', 'Writing configuration...');
  try {
    const authExternalUrl = await getAuthentikExternalUrl();
    if (!authExternalUrl) {
      throw new Error('Could not determine Authentik external URL from Caddy config. Ensure Authentik is running and has a Caddy route configured.');
    }
    const authUrl = authExternalUrl;
    const authentikIP = await getContainerIP('youeye-authentik');
    const authentikInternalUrl = authentikIP
      ? `http://${authentikIP}:9000`
      : 'http://youeye-authentik.incus:9000';

    const uiBaseUrl = `https://${config.domain}`;

    const envContent = [
      'NODE_ENV=production',
      'PORT=3000',
      'HOSTNAME=0.0.0.0',
      `AUTHENTIK_URL=${authUrl}`,
      `AUTHENTIK_INTERNAL_URL=${authentikInternalUrl}`,
      `AUTHENTIK_CLIENT_ID=${clientId}`,
      `AUTHENTIK_CLIENT_SECRET=${clientSecret}`,
      `JWT_SECRET=${jwtSecret}`,
      `SEARCH_EXTERNAL_URL=${appUrl}`,
      `NEXT_PUBLIC_APP_URL=${appUrl}`,
      'YOUEYE_API_URL=http://youeye-ui.incus:3000/api/v1',
      `YOUEYE_UI_URL=${uiBaseUrl}`,
      'SECURE_COOKIES=false',
      `SEARCH_ENGINE_TYPE=${engine.type}`,
      `SEARCH_ENGINE_URL=${engine.url}`,
    ].join('\n') + '\n'; // BUG-023: Ensure trailing newline

    const b64 = Buffer.from(envContent).toString('base64');
    await execShell(
      containerName,
      `echo '${b64}' | base64 -d > /etc/${containerName}.env`,
      { timeout: 10_000 }
    );

    await execShell(containerName, `systemctl restart ${containerName}`, { timeout: 20_000 });
    emit(onEvent, 5, TOTAL_STEPS, 'success', `Configuration written — using ${engine.type} at ${engine.containerName}`);
  } catch (err) {
    emit(onEvent, 5, TOTAL_STEPS, 'error', 'Failed to write configuration', String(err));
    throw err;
  }

  // ── Step 6: Health check ──────────────────────────────────
  emit(onEvent, 6, TOTAL_STEPS, 'running', 'Waiting for Search to be healthy...');
  let healthy = false;
  for (let i = 0; i < 30; i++) {
    try {
      const result = await execShell(
        containerName,
        'curl -sf http://localhost:3000/api/health',
        { timeout: 5000 }
      );
      if (result.exitCode === 0) {
        healthy = true;
        break;
      }
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  emit(
    onEvent,
    6,
    TOTAL_STEPS,
    healthy ? 'success' : 'error',
    healthy ? 'Search is healthy' : 'Search health check timed out (may still be starting)'
  );

  // ── Step 7: Add Caddy route ───────────────────────────────
  emit(onEvent, 7, TOTAL_STEPS, 'running', 'Configuring reverse proxy...');
  try {
    await addRoute({
      hostname: `${config.subdomain}.${config.domain}`,
      path: '/*',
      upstream: containerName,
      port: 3000,
    });
    emit(onEvent, 7, TOTAL_STEPS, 'success', `Route added: ${config.subdomain}.${config.domain}`);
  } catch (err) {
    const msg = String(err);
    if (msg.toLowerCase().includes('already exists')) {
      emit(onEvent, 7, TOTAL_STEPS, 'success', 'Caddy route already configured');
    } else {
      emit(onEvent, 7, TOTAL_STEPS, 'error', 'Failed to configure reverse proxy', msg);
      throw err;
    }
  }

  // ── Step 8: Ensure ping route ────────────────────────────
  try { await ensurePingRoute('youeye-control', 3000); } catch { /* non-fatal */ }

  // ── Step 9: Register with dashboard ─────────────────────
  await registerAppWithUI('ye-search', config.customName || 'Search', config.subdomain, containerName, config.customIcon || 'Search', onEvent, 8, TOTAL_STEPS);

  // ── Step 10: Save metadata + Done ────────────────────────
  const meta: InstallMetadata = {
    appId: 'search',
    type: 'native',
    subdomain: config.subdomain,
    domain: config.domain,
    enableSSO: true,
    installedAt: new Date().toISOString(),
    containers: [containerName],
    ssoSlug: 'ye-search',
    ssoClientId: clientId,
  };
  await saveInstallMetadata(meta);
  emit(onEvent, 10, TOTAL_STEPS, 'success', 'Search installed successfully!');

  } catch (err) {
    // Rollback: remove orphaned Authentik SSO app
    try { await removeAuthentikOAuth2App('ye-search'); } catch { /* best-effort */ }
    throw err;
  }
}

// ─── Notes Installer ──────────────────────────────────────

async function installNotes(
  config: NativeInstallConfig,
  onEvent: InstallEventCallback
): Promise<void> {
  const TOTAL_STEPS = 10;
  const containerName = 'ye-app-notes';
  const appUrl = `https://${config.subdomain}.${config.domain}`;

  // Check for previous install data (reinstall after keepData=true)
  const previousInstall = await detectPreviousInstall('notes');
  if (previousInstall) {
    emit(onEvent, 0, TOTAL_STEPS, 'running', 'Restoring existing app data — reinstall detected');
  }

  // ── Step 1: Generate secrets ──────────────────────────────
  emit(onEvent, 1, TOTAL_STEPS, 'running', 'Generating secrets...');
  const jwtSecret = generateSecretKey(64);
  // Use URL-safe password (base64url) to avoid +, /, = in DATABASE_URL connection string
  const dbPassword = generatePassword(32);
  emit(onEvent, 1, TOTAL_STEPS, 'success', 'Secrets generated');

  // ── Step 2: Create PostgreSQL database ────────────────────
  emit(onEvent, 2, TOTAL_STEPS, 'running', 'Creating PostgreSQL database...');
  try {
    const checkUser = await execShell(
      'youeye-postgres',
      "psql -U youeye -tAc \"SELECT 1 FROM pg_roles WHERE rolname='ye_notes'\"",
      { timeout: 10_000 }
    );
    if (!checkUser.stdout.includes('1')) {
      await execShell(
        'youeye-postgres',
        `psql -U youeye -c "CREATE USER ye_notes WITH PASSWORD '${dbPassword}'"`,
        { timeout: 10_000 }
      );
    } else {
      await execShell(
        'youeye-postgres',
        `psql -U youeye -c "ALTER USER ye_notes WITH PASSWORD '${dbPassword}'"`,
        { timeout: 10_000 }
      );
    }
    const checkDB = await execShell(
      'youeye-postgres',
      "psql -U youeye -tAc \"SELECT 1 FROM pg_database WHERE datname='ye_notes'\"",
      { timeout: 10_000 }
    );
    if (!checkDB.stdout.includes('1')) {
      await execShell(
        'youeye-postgres',
        'psql -U youeye -c "CREATE DATABASE ye_notes OWNER ye_notes"',
        { timeout: 10_000 }
      );
    }
    emit(onEvent, 2, TOTAL_STEPS, 'success', 'PostgreSQL database created');
  } catch (err) {
    emit(onEvent, 2, TOTAL_STEPS, 'error', 'Failed to create database', String(err));
    throw err;
  }

  // ── Step 3: Create Authentik OAuth2 app ───────────────────
  emit(onEvent, 3, TOTAL_STEPS, 'running', 'Creating SSO application in Authentik...');
  let clientId = 'ye-notes';
  let clientSecret = '';
  try {
    const ssoResult = await createAuthentikOAuth2App({
      slug: 'ye-notes',
      name: 'Notes',
      redirectUris: [{ matching_mode: 'strict', url: `${appUrl}/api/auth/callback` }],
      launchUrl: appUrl,
      implicitConsent: true,
    });
    clientId = ssoResult.clientId;
    clientSecret = ssoResult.clientSecret;
    emit(onEvent, 3, TOTAL_STEPS, 'success', 'Authentik SSO application created');
  } catch (err) {
    emit(onEvent, 3, TOTAL_STEPS, 'error', 'Failed to create SSO application', String(err));
    throw err;
  }

  // Wrap remaining steps so we clean up the SSO app on failure
  try {

  // ── Step 4: Deploy LXD container ─────────────────────────
  emit(onEvent, 4, TOTAL_STEPS, 'running', 'Deploying Notes container (this takes several minutes)...');
  try {
    await deployLXDContainer(
      {
        name: 'ye-notes',
        displayName: 'Notes',
        containerName,
        image: 'debian/12',
        imageServer: 'https://images.linuxcontainers.org',
        imageProtocol: 'simplestreams',
        nodeVersion: '22.x',
        appDir: '/opt/app',
        port: 3000,
      },
      {
        spineSocketPath: '/var/run/spine/spine.sock',
        giteaBaseURL: GITEA_BASE,
        giteaOrg: GITEA_ORG,
        giteaRepo: nativeGiteaRepo(config.appId),
      }
    );
    emit(onEvent, 4, TOTAL_STEPS, 'success', 'Notes container deployed');
  } catch (err) {
    emit(onEvent, 4, TOTAL_STEPS, 'error', 'Container deployment failed', String(err));
    throw err;
  }

  // ── Step 5: Write env file ────────────────────────────────
  emit(onEvent, 5, TOTAL_STEPS, 'running', 'Writing configuration...');
  try {
    const authExternalUrl = await getAuthentikExternalUrl();
    if (!authExternalUrl) {
      throw new Error('Could not determine Authentik external URL from Caddy config. Ensure Authentik is running and has a Caddy route configured.');
    }
    const authUrl = authExternalUrl;
    const authentikIP = await getContainerIP('youeye-authentik');
    const authentikInternalUrl = authentikIP
      ? `http://${authentikIP}:9000`
      : 'http://youeye-authentik.incus:9000';
    const postgresIP = await getContainerIP('youeye-postgres');
    const postgresHost = postgresIP || 'youeye-postgres.incus';

    const uiBaseUrl = `https://${config.domain}`;

    const envContent = [
      'NODE_ENV=production',
      'PORT=3000',
      'HOSTNAME=0.0.0.0',
      `AUTHENTIK_URL=${authUrl}`,
      `AUTHENTIK_INTERNAL_URL=${authentikInternalUrl}`,
      `AUTHENTIK_CLIENT_ID=${clientId}`,
      `AUTHENTIK_CLIENT_SECRET=${clientSecret}`,
      `JWT_SECRET=${jwtSecret}`,
      `NOTES_EXTERNAL_URL=${appUrl}`,
      `NEXT_PUBLIC_APP_URL=${appUrl}`,
      'YOUEYE_API_URL=http://youeye-ui.incus:3000/api/v1',
      `YOUEYE_UI_URL=${uiBaseUrl}`,
      'SECURE_COOKIES=false',
      `DATABASE_URL=postgresql://ye_notes:${dbPassword}@${postgresHost}:5432/ye_notes?sslmode=disable`,
    ].join('\n') + '\n'; // BUG-023: Ensure trailing newline

    const b64 = Buffer.from(envContent).toString('base64');
    await execShell(
      containerName,
      `echo '${b64}' | base64 -d > /etc/${containerName}.env`,
      { timeout: 10_000 }
    );

    await execShell(containerName, `systemctl restart ${containerName}`, { timeout: 20_000 });
    emit(onEvent, 5, TOTAL_STEPS, 'success', 'Configuration written and service restarted');
  } catch (err) {
    emit(onEvent, 5, TOTAL_STEPS, 'error', 'Failed to write configuration', String(err));
    throw err;
  }

  // ── Step 6: Health check ──────────────────────────────────
  emit(onEvent, 6, TOTAL_STEPS, 'running', 'Waiting for Notes to be healthy...');
  let healthy = false;
  for (let i = 0; i < 30; i++) {
    try {
      const result = await execShell(
        containerName,
        'curl -sf http://localhost:3000/api/health',
        { timeout: 5000 }
      );
      if (result.exitCode === 0) {
        healthy = true;
        break;
      }
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  emit(
    onEvent,
    6,
    TOTAL_STEPS,
    healthy ? 'success' : 'error',
    healthy ? 'Notes is healthy' : 'Notes health check timed out (may still be starting)'
  );

  // ── Step 7: Add Caddy route ───────────────────────────────
  emit(onEvent, 7, TOTAL_STEPS, 'running', 'Configuring reverse proxy...');
  try {
    await addRoute({
      hostname: `${config.subdomain}.${config.domain}`,
      path: '/*',
      upstream: containerName,
      port: 3000,
    });
    emit(onEvent, 7, TOTAL_STEPS, 'success', `Route added: ${config.subdomain}.${config.domain}`);
  } catch (err) {
    const msg = String(err);
    if (msg.toLowerCase().includes('already exists')) {
      emit(onEvent, 7, TOTAL_STEPS, 'success', 'Caddy route already configured');
    } else {
      emit(onEvent, 7, TOTAL_STEPS, 'error', 'Failed to configure reverse proxy', msg);
      throw err;
    }
  }

  // ── Step 8: Ensure ping route ────────────────────────────
  try { await ensurePingRoute('youeye-control', 3000); } catch { /* non-fatal */ }

  // ── Step 9: Register with dashboard ─────────────────────
  await registerAppWithUI('ye-notes', config.customName || 'Notes', config.subdomain, containerName, config.customIcon || 'StickyNote', onEvent, 8, TOTAL_STEPS);

  // ── Step 10: Save metadata + Done ────────────────────────
  const meta: InstallMetadata = {
    appId: 'notes',
    type: 'native',
    subdomain: config.subdomain,
    domain: config.domain,
    enableSSO: true,
    installedAt: new Date().toISOString(),
    containers: [containerName],
    ssoSlug: 'ye-notes',
    ssoClientId: clientId,
  };
  await saveInstallMetadata(meta);
  emit(onEvent, 10, TOTAL_STEPS, 'success', 'Notes installed successfully!');

  } catch (err) {
    // Rollback: remove orphaned Authentik SSO app
    try { await removeAuthentikOAuth2App('ye-notes'); } catch { /* best-effort */ }
    throw err;
  }
}

// ─── Cinema Installer ─────────────────────────────────────

async function installCinema(
  config: NativeInstallConfig,
  onEvent: InstallEventCallback
): Promise<void> {
  const TOTAL_STEPS = 10;
  const containerName = 'ye-app-cinema';
  const appUrl = `https://${config.subdomain}.${config.domain}`;

  // Check for previous install data (reinstall after keepData=true)
  const previousInstall = await detectPreviousInstall('cinema');
  if (previousInstall) {
    emit(onEvent, 0, TOTAL_STEPS, 'running', 'Restoring existing app data — reinstall detected');
  }

  // ── Step 1: Generate secrets ──────────────────────────────
  emit(onEvent, 1, TOTAL_STEPS, 'running', 'Generating secrets...');
  const jwtSecret = generateSecretKey(64);
  // Use URL-safe password (base64url) to avoid +, /, = in DATABASE_URL connection string
  const dbPassword = generatePassword(32);
  emit(onEvent, 1, TOTAL_STEPS, 'success', 'Secrets generated');

  // ── Step 2: Create PostgreSQL database ────────────────────
  emit(onEvent, 2, TOTAL_STEPS, 'running', 'Creating PostgreSQL database...');
  try {
    const checkUser = await execShell(
      'youeye-postgres',
      "psql -U youeye -tAc \"SELECT 1 FROM pg_roles WHERE rolname='ye_cinema'\"",
      { timeout: 10_000 }
    );
    if (!checkUser.stdout.includes('1')) {
      await execShell(
        'youeye-postgres',
        `psql -U youeye -c "CREATE USER ye_cinema WITH PASSWORD '${dbPassword}'"`,
        { timeout: 10_000 }
      );
    } else {
      await execShell(
        'youeye-postgres',
        `psql -U youeye -c "ALTER USER ye_cinema WITH PASSWORD '${dbPassword}'"`,
        { timeout: 10_000 }
      );
    }
    const checkDB = await execShell(
      'youeye-postgres',
      "psql -U youeye -tAc \"SELECT 1 FROM pg_database WHERE datname='ye_cinema'\"",
      { timeout: 10_000 }
    );
    if (!checkDB.stdout.includes('1')) {
      await execShell(
        'youeye-postgres',
        'psql -U youeye -c "CREATE DATABASE ye_cinema OWNER ye_cinema"',
        { timeout: 10_000 }
      );
    }
    emit(onEvent, 2, TOTAL_STEPS, 'success', 'PostgreSQL database created');
  } catch (err) {
    emit(onEvent, 2, TOTAL_STEPS, 'error', 'Failed to create database', String(err));
    throw err;
  }

  // ── Step 3: Create Authentik OAuth2 app ───────────────────
  emit(onEvent, 3, TOTAL_STEPS, 'running', 'Creating SSO application in Authentik...');
  let clientId = 'ye-cinema';
  let clientSecret = '';
  try {
    const ssoResult = await createAuthentikOAuth2App({
      slug: 'ye-cinema',
      name: 'Cinema',
      redirectUris: [{ matching_mode: 'strict', url: `${appUrl}/api/auth/callback` }],
      launchUrl: appUrl,
      implicitConsent: true,
    });
    clientId = ssoResult.clientId;
    clientSecret = ssoResult.clientSecret;
    emit(onEvent, 3, TOTAL_STEPS, 'success', 'Authentik SSO application created');
  } catch (err) {
    emit(onEvent, 3, TOTAL_STEPS, 'error', 'Failed to create SSO application', String(err));
    throw err;
  }

  // Wrap remaining steps so we clean up the SSO app on failure
  try {

  // ── Step 4: Deploy LXD container ─────────────────────────
  emit(onEvent, 4, TOTAL_STEPS, 'running', 'Deploying Cinema container (this takes several minutes)...');
  try {
    await deployLXDContainer(
      {
        name: 'ye-cinema',
        displayName: 'Cinema',
        containerName,
        image: 'debian/12',
        imageServer: 'https://images.linuxcontainers.org',
        imageProtocol: 'simplestreams',
        nodeVersion: '22.x',
        appDir: '/opt/app',
        port: 3000,
      },
      {
        spineSocketPath: '/var/run/spine/spine.sock',
        giteaBaseURL: GITEA_BASE,
        giteaOrg: GITEA_ORG,
        giteaRepo: nativeGiteaRepo(config.appId),
      }
    );
    emit(onEvent, 4, TOTAL_STEPS, 'success', 'Cinema container deployed');
  } catch (err) {
    emit(onEvent, 4, TOTAL_STEPS, 'error', 'Container deployment failed', String(err));
    throw err;
  }

  // ── Step 5: Write env file ────────────────────────────────
  emit(onEvent, 5, TOTAL_STEPS, 'running', 'Writing configuration...');
  try {
    const authExternalUrl = await getAuthentikExternalUrl();
    if (!authExternalUrl) {
      throw new Error('Could not determine Authentik external URL from Caddy config. Ensure Authentik is running and has a Caddy route configured.');
    }
    const authUrl = authExternalUrl;
    const authentikIP = await getContainerIP('youeye-authentik');
    const authentikInternalUrl = authentikIP
      ? `http://${authentikIP}:9000`
      : 'http://youeye-authentik.incus:9000';
    const postgresIP = await getContainerIP('youeye-postgres');
    const postgresHost = postgresIP || 'youeye-postgres.incus';

    // TMDB_API_KEY: provided by the install wizard (required for content to load)
    const tmdbApiKey = config.installParams?.tmdbApiKey ?? '';
    if (!tmdbApiKey) {
      emit(onEvent, 5, TOTAL_STEPS, 'running', 'Warning: TMDB_API_KEY not provided — content will not load until configured');
    }

    const uiBaseUrl = `https://${config.domain}`;

    const envContent = [
      'NODE_ENV=production',
      'PORT=3000',
      'HOSTNAME=0.0.0.0',
      `AUTHENTIK_URL=${authUrl}`,
      `AUTHENTIK_INTERNAL_URL=${authentikInternalUrl}`,
      `AUTHENTIK_CLIENT_ID=${clientId}`,
      `AUTHENTIK_CLIENT_SECRET=${clientSecret}`,
      `JWT_SECRET=${jwtSecret}`,
      `CINEMA_EXTERNAL_URL=${appUrl}`,
      `NEXT_PUBLIC_APP_URL=${appUrl}`,
      'YOUEYE_API_URL=http://youeye-ui.incus:3000/api/v1',
      `YOUEYE_UI_URL=${uiBaseUrl}`,
      'SECURE_COOKIES=false',
      `DATABASE_URL=postgresql://ye_cinema:${dbPassword}@${postgresHost}:5432/ye_cinema?sslmode=disable`,
      `TMDB_API_KEY=${tmdbApiKey}`,
    ].join('\n') + '\n'; // BUG-023: Ensure trailing newline

    const b64 = Buffer.from(envContent).toString('base64');
    await execShell(
      containerName,
      `echo '${b64}' | base64 -d > /etc/${containerName}.env`,
      { timeout: 10_000 }
    );

    await execShell(containerName, `systemctl restart ${containerName}`, { timeout: 20_000 });
    emit(onEvent, 5, TOTAL_STEPS, 'success', 'Configuration written and service restarted');
  } catch (err) {
    emit(onEvent, 5, TOTAL_STEPS, 'error', 'Failed to write configuration', String(err));
    throw err;
  }

  // ── Step 6: Health check ──────────────────────────────────
  emit(onEvent, 6, TOTAL_STEPS, 'running', 'Waiting for Cinema to be healthy...');
  let healthy = false;
  for (let i = 0; i < 30; i++) {
    try {
      const result = await execShell(
        containerName,
        'curl -sf http://localhost:3000/api/health',
        { timeout: 5000 }
      );
      if (result.exitCode === 0) {
        healthy = true;
        break;
      }
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  emit(
    onEvent,
    6,
    TOTAL_STEPS,
    healthy ? 'success' : 'error',
    healthy ? 'Cinema is healthy' : 'Cinema health check timed out (may still be starting)'
  );

  // ── Step 7: Add Caddy route ───────────────────────────────
  emit(onEvent, 7, TOTAL_STEPS, 'running', 'Configuring reverse proxy...');
  try {
    await addRoute({
      hostname: `${config.subdomain}.${config.domain}`,
      path: '/*',
      upstream: containerName,
      port: 3000,
    });
    emit(onEvent, 7, TOTAL_STEPS, 'success', `Route added: ${config.subdomain}.${config.domain}`);
  } catch (err) {
    const msg = String(err);
    if (msg.toLowerCase().includes('already exists')) {
      emit(onEvent, 7, TOTAL_STEPS, 'success', 'Caddy route already configured');
    } else {
      emit(onEvent, 7, TOTAL_STEPS, 'error', 'Failed to configure reverse proxy', msg);
      throw err;
    }
  }

  // ── Step 8: Ensure ping route ────────────────────────────
  try { await ensurePingRoute('youeye-control', 3000); } catch { /* non-fatal */ }

  // ── Step 9: Register with dashboard ─────────────────────
  await registerAppWithUI('ye-cinema', config.customName || 'Cinema', config.subdomain, containerName, config.customIcon || 'Film', onEvent, 8, TOTAL_STEPS);

  // ── Step 10: Save metadata + Done ────────────────────────
  const meta: InstallMetadata = {
    appId: 'cinema',
    type: 'native',
    subdomain: config.subdomain,
    domain: config.domain,
    enableSSO: true,
    installedAt: new Date().toISOString(),
    containers: [containerName],
    ssoSlug: 'ye-cinema',
    ssoClientId: clientId,
  };
  await saveInstallMetadata(meta);
  emit(onEvent, 10, TOTAL_STEPS, 'success', 'Cinema installed successfully!');

  } catch (err) {
    // Rollback: remove orphaned Authentik SSO app
    try { await removeAuthentikOAuth2App('ye-cinema'); } catch { /* best-effort */ }
    throw err;
  }
}
// ─── Weather Installer ─────────────────────────────────────

async function installWeather(
  config: NativeInstallConfig,
  onEvent: InstallEventCallback
): Promise<void> {
  const TOTAL_STEPS = 10;
  const containerName = 'ye-app-weather';
  const appUrl = `https://${config.subdomain}.${config.domain}`;

  // Check for previous install data (reinstall after keepData=true)
  const previousInstall = await detectPreviousInstall('weather');
  if (previousInstall) {
    emit(onEvent, 0, TOTAL_STEPS, 'running', 'Restoring existing app data — reinstall detected');
  }

  // ── Step 1: Generate secrets ──────────────────────────────
  emit(onEvent, 1, TOTAL_STEPS, 'running', 'Generating secrets...');
  const jwtSecret = generateSecretKey(64);
  const dbPassword = generatePassword(32);
  emit(onEvent, 1, TOTAL_STEPS, 'success', 'Secrets generated');

  // ── Step 2: Create PostgreSQL database ────────────────────
  emit(onEvent, 2, TOTAL_STEPS, 'running', 'Creating PostgreSQL database...');
  try {
    const checkUser = await execShell(
      'youeye-postgres',
      "psql -U youeye -tAc \"SELECT 1 FROM pg_roles WHERE rolname='ye_weather'\"",
      { timeout: 10_000 }
    );
    if (!checkUser.stdout.includes('1')) {
      await execShell(
        'youeye-postgres',
        `psql -U youeye -c "CREATE USER ye_weather WITH PASSWORD '${dbPassword}'"`,
        { timeout: 10_000 }
      );
    } else {
      await execShell(
        'youeye-postgres',
        `psql -U youeye -c "ALTER USER ye_weather WITH PASSWORD '${dbPassword}'"`,
        { timeout: 10_000 }
      );
    }
    const checkDB = await execShell(
      'youeye-postgres',
      "psql -U youeye -tAc \"SELECT 1 FROM pg_database WHERE datname='ye_weather'\"",
      { timeout: 10_000 }
    );
    if (!checkDB.stdout.includes('1')) {
      await execShell(
        'youeye-postgres',
        'psql -U youeye -c "CREATE DATABASE ye_weather OWNER ye_weather"',
        { timeout: 10_000 }
      );
    }
    emit(onEvent, 2, TOTAL_STEPS, 'success', 'PostgreSQL database created');
  } catch (err) {
    emit(onEvent, 2, TOTAL_STEPS, 'error', 'Failed to create database', String(err));
    throw err;
  }

  // ── Step 3: Create Authentik OAuth2 app ───────────────────
  emit(onEvent, 3, TOTAL_STEPS, 'running', 'Creating SSO application in Authentik...');
  let clientId = 'ye-weather';
  let clientSecret = '';
  try {
    const ssoResult = await createAuthentikOAuth2App({
      slug: 'ye-weather',
      name: 'Weather',
      redirectUris: [{ matching_mode: 'strict', url: `${appUrl}/api/auth/callback` }],
      launchUrl: appUrl,
      implicitConsent: true,
    });
    clientId = ssoResult.clientId;
    clientSecret = ssoResult.clientSecret;
    emit(onEvent, 3, TOTAL_STEPS, 'success', 'Authentik SSO application created');
  } catch (err) {
    emit(onEvent, 3, TOTAL_STEPS, 'error', 'Failed to create SSO application', String(err));
    throw err;
  }

  // Wrap remaining steps so we clean up the SSO app on failure
  try {

  // ── Step 4: Deploy LXD container ─────────────────────────
  emit(onEvent, 4, TOTAL_STEPS, 'running', 'Deploying Weather container (this takes several minutes)...');
  try {
    await deployLXDContainer(
      {
        name: 'ye-weather',
        displayName: 'Weather',
        containerName,
        image: 'debian/12',
        imageServer: 'https://images.linuxcontainers.org',
        imageProtocol: 'simplestreams',
        nodeVersion: '22.x',
        appDir: '/opt/app',
        port: 3000,
      },
      {
        spineSocketPath: '/var/run/spine/spine.sock',
        giteaBaseURL: GITEA_BASE,
        giteaOrg: GITEA_ORG,
        giteaRepo: nativeGiteaRepo(config.appId),
      }
    );
    emit(onEvent, 4, TOTAL_STEPS, 'success', 'Weather container deployed');
  } catch (err) {
    emit(onEvent, 4, TOTAL_STEPS, 'error', 'Container deployment failed', String(err));
    throw err;
  }

  // ── Step 5: Write env file ────────────────────────────────
  emit(onEvent, 5, TOTAL_STEPS, 'running', 'Writing configuration...');
  try {
    const authExternalUrl = await getAuthentikExternalUrl();
    if (!authExternalUrl) {
      throw new Error('Could not determine Authentik external URL from Caddy config. Ensure Authentik is running and has a Caddy route configured.');
    }
    const authUrl = authExternalUrl;
    const authentikIP = await getContainerIP('youeye-authentik');
    const authentikInternalUrl = authentikIP
      ? `http://${authentikIP}:9000`
      : 'http://youeye-authentik.incus:9000';
    const postgresIP = await getContainerIP('youeye-postgres');
    const postgresHost = postgresIP || 'youeye-postgres.incus';

    const uiBaseUrl = `https://${config.domain}`;

    const envContent = [
      'NODE_ENV=production',
      'PORT=3000',
      'HOSTNAME=0.0.0.0',
      // NOTE: NODE_OPTIONS=--dns-result-order=ipv4first is intentionally omitted.
      // It only affects dns.lookup() and has NO effect on undici/fetch (Node.js v22
      // global fetch uses its own DNS resolver, independent of --dns-result-order).
      // The authoritative fix is disabling IPv6 at the sysctl level (done below).
      `AUTHENTIK_URL=${authUrl}`,
      `AUTHENTIK_INTERNAL_URL=${authentikInternalUrl}`,
      `AUTHENTIK_CLIENT_ID=${clientId}`,
      `AUTHENTIK_CLIENT_SECRET=${clientSecret}`,
      `JWT_SECRET=${jwtSecret}`,
      `WEATHER_EXTERNAL_URL=${appUrl}`,
      `NEXT_PUBLIC_APP_URL=${appUrl}`,
      'YOUEYE_API_URL=http://youeye-ui.incus:3000/api/v1',
      `YOUEYE_UI_URL=${uiBaseUrl}`,
      'SECURE_COOKIES=false',
      `DATABASE_URL=postgresql://ye_weather:${dbPassword}@${postgresHost}:5432/ye_weather?sslmode=disable`,
    ].join('\n') + '\n'; // Ensure trailing newline (BUG-023 fix)

    const b64 = Buffer.from(envContent).toString('base64');
    await execShell(
      containerName,
      `echo '${b64}' | base64 -d > /etc/${containerName}.env`,
      { timeout: 10_000 }
    );

    // Disable IPv6 on ALL interfaces in the container (BUG-LISA-001).
    //
    // Node.js v22 global fetch() uses undici which runs happy-eyeballs: it races
    // IPv4 and IPv6 connections simultaneously. Incus containers have a link-local
    // IPv6 address on eth0 but no global IPv6 route, so IPv6 connections fail with
    // ETIMEDOUT. Unlike curl, undici does NOT fall back cleanly when IPv6 fails fast.
    //
    // Fix: disable IPv6 per-interface. The 'all' sysctl does NOT override an existing
    // per-interface setting of 0 (Linux processes per-interface > 'all'). We must set
    // eth0 and lo explicitly. Persisted to /etc/sysctl.d/99-disable-ipv6.conf so it
    // survives container reboots.
    try {
      await execShell(
        containerName,
        [
          'sysctl -w net.ipv6.conf.all.disable_ipv6=1',
          'sysctl -w net.ipv6.conf.default.disable_ipv6=1',
          'sysctl -w net.ipv6.conf.eth0.disable_ipv6=1',
          'sysctl -w net.ipv6.conf.lo.disable_ipv6=1',
          // Persist to /etc/sysctl.d/ (takes effect on next boot)
          'mkdir -p /etc/sysctl.d',
          'echo net.ipv6.conf.all.disable_ipv6=1 > /etc/sysctl.d/99-disable-ipv6.conf',
          'echo net.ipv6.conf.default.disable_ipv6=1 >> /etc/sysctl.d/99-disable-ipv6.conf',
          'echo net.ipv6.conf.eth0.disable_ipv6=1 >> /etc/sysctl.d/99-disable-ipv6.conf',
          'echo net.ipv6.conf.lo.disable_ipv6=1 >> /etc/sysctl.d/99-disable-ipv6.conf',
        ].join(' && '),
        { timeout: 10_000 }
      );
    } catch {
      // Non-fatal: sysctl may be restricted in some container configurations.
      // Log and continue — the app may still work if the host blocks IPv6 routing.
    }

    await execShell(containerName, `systemctl restart ${containerName}`, { timeout: 20_000 });
    emit(onEvent, 5, TOTAL_STEPS, 'success', 'Configuration written and service restarted');
  } catch (err) {
    emit(onEvent, 5, TOTAL_STEPS, 'error', 'Failed to write configuration', String(err));
    throw err;
  }

  // ── Step 6: Health check ──────────────────────────────────
  emit(onEvent, 6, TOTAL_STEPS, 'running', 'Waiting for Weather to be healthy...');
  let healthy = false;
  for (let i = 0; i < 30; i++) {
    try {
      const result = await execShell(
        containerName,
        'curl -sf http://localhost:3000/api/health',
        { timeout: 5000 }
      );
      if (result.exitCode === 0) {
        healthy = true;
        break;
      }
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  emit(
    onEvent,
    6,
    TOTAL_STEPS,
    healthy ? 'success' : 'error',
    healthy ? 'Weather is healthy' : 'Weather health check timed out (may still be starting)'
  );

  // ── Step 7: Add Caddy route ───────────────────────────────
  emit(onEvent, 7, TOTAL_STEPS, 'running', 'Configuring reverse proxy...');
  try {
    await addRoute({
      hostname: `${config.subdomain}.${config.domain}`,
      path: '/*',
      upstream: containerName,
      port: 3000,
    });
    emit(onEvent, 7, TOTAL_STEPS, 'success', `Route added: ${config.subdomain}.${config.domain}`);
  } catch (err) {
    const msg = String(err);
    if (msg.toLowerCase().includes('already exists')) {
      emit(onEvent, 7, TOTAL_STEPS, 'success', 'Caddy route already configured');
    } else {
      emit(onEvent, 7, TOTAL_STEPS, 'error', 'Failed to configure reverse proxy', msg);
      throw err;
    }
  }

  // ── Step 8: Ensure ping route ────────────────────────────
  try { await ensurePingRoute('youeye-control', 3000); } catch { /* non-fatal */ }

  // ── Step 9: Register with dashboard ─────────────────────
  await registerAppWithUI('ye-weather', config.customName || 'Weather', config.subdomain, containerName, config.customIcon || 'CloudSun', onEvent, 8, TOTAL_STEPS);

  // ── Step 10: Save metadata + Done ────────────────────────
  const meta: InstallMetadata = {
    appId: 'weather',
    type: 'native',
    subdomain: config.subdomain,
    domain: config.domain,
    enableSSO: true,
    installedAt: new Date().toISOString(),
    containers: [containerName],
    ssoSlug: 'ye-weather',
    ssoClientId: clientId,
  };
  await saveInstallMetadata(meta);
  emit(onEvent, 10, TOTAL_STEPS, 'success', 'Weather installed successfully!');

  } catch (err) {
    // Rollback: remove orphaned Authentik SSO app
    try { await removeAuthentikOAuth2App('ye-weather'); } catch { /* best-effort */ }
    throw err;
  }
}

// ─── Translate Installer ───────────────────────────────────

async function installTranslate(
  config: NativeInstallConfig,
  onEvent: InstallEventCallback
): Promise<void> {
  const TOTAL_STEPS = 10;
  const containerName = 'ye-app-translate';
  const appUrl = `https://${config.subdomain}.${config.domain}`;

  const previousInstall = await detectPreviousInstall('translate');
  if (previousInstall) {
    emit(onEvent, 0, TOTAL_STEPS, 'running', 'Restoring existing app data — reinstall detected');
  }

  // ── Step 1: Generate secrets ──────────────────────────────
  emit(onEvent, 1, TOTAL_STEPS, 'running', 'Generating secrets...');
  const jwtSecret = generateSecretKey(64);
  const dbPassword = generatePassword(32);
  emit(onEvent, 1, TOTAL_STEPS, 'success', 'Secrets generated');

  // ── Step 2: Create PostgreSQL database ────────────────────
  emit(onEvent, 2, TOTAL_STEPS, 'running', 'Creating PostgreSQL database...');
  try {
    const checkUser = await execShell(
      'youeye-postgres',
      "psql -U youeye -tAc \"SELECT 1 FROM pg_roles WHERE rolname='ye_translate'\"",
      { timeout: 10_000 }
    );
    if (!checkUser.stdout.includes('1')) {
      await execShell(
        'youeye-postgres',
        `psql -U youeye -c "CREATE USER ye_translate WITH PASSWORD '${dbPassword}'"`,
        { timeout: 10_000 }
      );
    } else {
      await execShell(
        'youeye-postgres',
        `psql -U youeye -c "ALTER USER ye_translate WITH PASSWORD '${dbPassword}'"`,
        { timeout: 10_000 }
      );
    }
    const checkDB = await execShell(
      'youeye-postgres',
      "psql -U youeye -tAc \"SELECT 1 FROM pg_database WHERE datname='ye_translate'\"",
      { timeout: 10_000 }
    );
    if (!checkDB.stdout.includes('1')) {
      await execShell(
        'youeye-postgres',
        'psql -U youeye -c "CREATE DATABASE ye_translate OWNER ye_translate"',
        { timeout: 10_000 }
      );
    }
    emit(onEvent, 2, TOTAL_STEPS, 'success', 'PostgreSQL database created');
  } catch (err) {
    emit(onEvent, 2, TOTAL_STEPS, 'error', 'Failed to create database', String(err));
    throw err;
  }

  // ── Step 3: Create Authentik OAuth2 app ───────────────────
  emit(onEvent, 3, TOTAL_STEPS, 'running', 'Creating SSO application in Authentik...');
  let clientId = 'ye-translate';
  let clientSecret = '';
  try {
    const ssoResult = await createAuthentikOAuth2App({
      slug: 'ye-translate',
      name: 'Translate',
      redirectUris: [{ matching_mode: 'strict', url: `${appUrl}/api/auth/callback` }],
      launchUrl: appUrl,
      implicitConsent: true,
    });
    clientId = ssoResult.clientId;
    clientSecret = ssoResult.clientSecret;
    emit(onEvent, 3, TOTAL_STEPS, 'success', 'Authentik SSO application created');
  } catch (err) {
    emit(onEvent, 3, TOTAL_STEPS, 'error', 'Failed to create SSO application', String(err));
    throw err;
  }

  // Wrap remaining steps so we clean up the SSO app on failure
  try {

  // ── Step 4: Deploy LXD container ─────────────────────────
  emit(onEvent, 4, TOTAL_STEPS, 'running', 'Deploying Translate container (this takes several minutes)...');
  try {
    await deployLXDContainer(
      {
        name: 'ye-translate',
        displayName: 'Translate',
        containerName,
        image: 'debian/12',
        imageServer: 'https://images.linuxcontainers.org',
        imageProtocol: 'simplestreams',
        nodeVersion: '22.x',
        appDir: '/opt/app',
        port: 3000,
      },
      {
        spineSocketPath: '/var/run/spine/spine.sock',
        giteaBaseURL: GITEA_BASE,
        giteaOrg: GITEA_ORG,
        giteaRepo: nativeGiteaRepo(config.appId),
      }
    );
    emit(onEvent, 4, TOTAL_STEPS, 'success', 'Translate container deployed');
  } catch (err) {
    emit(onEvent, 4, TOTAL_STEPS, 'error', 'Container deployment failed', String(err));
    throw err;
  }

  // ── Step 5: Write env file ────────────────────────────────
  emit(onEvent, 5, TOTAL_STEPS, 'running', 'Writing configuration...');
  try {
    const authExternalUrl = await getAuthentikExternalUrl();
    if (!authExternalUrl) {
      throw new Error('Could not determine Authentik external URL from Caddy config. Ensure Authentik is running and has a Caddy route configured.');
    }
    const authUrl = authExternalUrl;
    const authentikIP = await getContainerIP('youeye-authentik');
    const authentikInternalUrl = authentikIP
      ? `http://${authentikIP}:9000`
      : 'http://youeye-authentik.incus:9000';
    const postgresIP = await getContainerIP('youeye-postgres');
    const postgresHost = postgresIP || 'youeye-postgres.incus';

    const uiBaseUrl = `https://${config.domain}`;

    const envContent = [
      'NODE_ENV=production',
      'PORT=3000',
      'HOSTNAME=0.0.0.0',
      `AUTHENTIK_URL=${authUrl}`,
      `AUTHENTIK_INTERNAL_URL=${authentikInternalUrl}`,
      `AUTHENTIK_CLIENT_ID=${clientId}`,
      `AUTHENTIK_CLIENT_SECRET=${clientSecret}`,
      `JWT_SECRET=${jwtSecret}`,
      `TRANSLATE_EXTERNAL_URL=${appUrl}`,
      `NEXT_PUBLIC_APP_URL=${appUrl}`,
      'YOUEYE_API_URL=http://youeye-ui.incus:3000/api/v1',
      `YOUEYE_UI_URL=${uiBaseUrl}`,
      'SECURE_COOKIES=false',
      `DATABASE_URL=postgresql://ye_translate:${dbPassword}@${postgresHost}:5432/ye_translate?sslmode=disable`,
    ].join('\n') + '\n'; // BUG-023: Ensure trailing newline

    const b64 = Buffer.from(envContent).toString('base64');
    await execShell(
      containerName,
      `echo '${b64}' | base64 -d > /etc/${containerName}.env`,
      { timeout: 10_000 }
    );

    await execShell(containerName, `systemctl restart ${containerName}`, { timeout: 20_000 });
    emit(onEvent, 5, TOTAL_STEPS, 'success', 'Configuration written and service restarted');
  } catch (err) {
    emit(onEvent, 5, TOTAL_STEPS, 'error', 'Failed to write configuration', String(err));
    throw err;
  }

  // ── Step 6: Health check ──────────────────────────────────
  emit(onEvent, 6, TOTAL_STEPS, 'running', 'Waiting for Translate to be healthy...');
  let healthy = false;
  for (let i = 0; i < 30; i++) {
    try {
      const result = await execShell(
        containerName,
        'curl -sf http://localhost:3000/api/health',
        { timeout: 5000 }
      );
      if (result.exitCode === 0) {
        healthy = true;
        break;
      }
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  emit(
    onEvent,
    6,
    TOTAL_STEPS,
    healthy ? 'success' : 'error',
    healthy ? 'Translate is healthy' : 'Translate health check timed out (may still be starting)'
  );

  // ── Step 7: Add Caddy route ───────────────────────────────
  emit(onEvent, 7, TOTAL_STEPS, 'running', 'Configuring reverse proxy...');
  try {
    await addRoute({
      hostname: `${config.subdomain}.${config.domain}`,
      path: '/*',
      upstream: containerName,
      port: 3000,
    });
    emit(onEvent, 7, TOTAL_STEPS, 'success', `Route added: ${config.subdomain}.${config.domain}`);
  } catch (err) {
    const msg = String(err);
    if (msg.toLowerCase().includes('already exists')) {
      emit(onEvent, 7, TOTAL_STEPS, 'success', 'Caddy route already configured');
    } else {
      emit(onEvent, 7, TOTAL_STEPS, 'error', 'Failed to configure reverse proxy', msg);
      throw err;
    }
  }

  // ── Step 8: Ensure ping route ────────────────────────────
  // Re-pin the /api/ping route to position 0 after adding the Translate route.
  // Without this, the Translate route displaces ping and breaks health checks (BUG-032).
  try { await ensurePingRoute('youeye-control', 3000); } catch { /* non-fatal */ }

  // ── Step 9: Register with dashboard ─────────────────────
  await registerAppWithUI('ye-translate', config.customName || 'Translate', config.subdomain, containerName, config.customIcon || 'Languages', onEvent, 8, TOTAL_STEPS);

  // ── Step 10: Save metadata + Done ────────────────────────
  const meta: InstallMetadata = {
    appId: 'translate',
    type: 'native',
    subdomain: config.subdomain,
    domain: config.domain,
    enableSSO: true,
    installedAt: new Date().toISOString(),
    containers: [containerName],
    ssoSlug: 'ye-translate',
    ssoClientId: clientId,
  };
  await saveInstallMetadata(meta);
  emit(onEvent, 10, TOTAL_STEPS, 'success', 'Translate installed successfully!');

  } catch (err) {
    // Rollback: remove orphaned Authentik SSO app
    try { await removeAuthentikOAuth2App('ye-translate'); } catch { /* best-effort */ }
    throw err;
  }
}

// ─── Native App Uninstaller ────────────────────────────────

export async function uninstallNativeApp(appId: string): Promise<void> {
  const containerName = nativeContainerName(appId);

  // Deregister from YE-UI dashboard (before container deletion)
  await deregisterAppFromUI(appId);

  // Remove Caddy route (find by upstream container name)
  try {
    const routes = await getRoutes();
    for (const route of routes) {
      if (route.upstream === containerName) {
        try {
          await removeRoute(route.id);
        } catch (err) {
          console.error(`[native-uninstall] Failed to remove Caddy route ${route.id}:`, err);
        }
      }
    }
  } catch (err) {
    console.error('[native-uninstall] Caddy route removal failed:', err);
  }

  // Remove Authentik OAuth2 app (wiki, search, notes, cinema)
  const ssoSlugMap: Record<string, string> = {
    'ye-wiki': 'ye-wiki',
    'ye-search': 'ye-search',
    'ye-notes': 'ye-notes',
    'ye-cinema': 'ye-cinema',
    'ye-weather': 'ye-weather',
    'ye-translate': 'ye-translate',
  };
  const ssoSlug = ssoSlugMap[appId];
  if (ssoSlug) {
    try {
      await removeAuthentikOAuth2App(ssoSlug);
    } catch (err) {
      console.error(`[native-uninstall] Authentik app removal failed for ${ssoSlug}:`, err);
    }
  }

  // Clean up PostgreSQL database for Notes
  if (appId === 'ye-notes' || appId === 'notes') {
    try {
      await execShell(
        'youeye-postgres',
        'psql -U youeye -c "DROP DATABASE IF EXISTS ye_notes"',
        { timeout: 10_000 }
      );
      await execShell(
        'youeye-postgres',
        'psql -U youeye -c "DROP USER IF EXISTS ye_notes"',
        { timeout: 10_000 }
      );
    } catch (err) {
      console.error('[native-uninstall] PostgreSQL cleanup failed for Notes:', err);
    }
  }

  // Clean up PostgreSQL database for Cinema
  if (appId === 'ye-cinema' || appId === 'cinema') {
    try {
      await execShell(
        'youeye-postgres',
        'psql -U youeye -c "DROP DATABASE IF EXISTS ye_cinema"',
        { timeout: 10_000 }
      );
      await execShell(
        'youeye-postgres',
        'psql -U youeye -c "DROP USER IF EXISTS ye_cinema"',
        { timeout: 10_000 }
      );
    } catch (err) {
      console.error('[native-uninstall] PostgreSQL cleanup failed for Cinema:', err);
    }
  }

  // Clean up PostgreSQL database for Weather
  if (appId === 'ye-weather' || appId === 'weather') {
    try {
      await execShell(
        'youeye-postgres',
        'psql -U youeye -c "DROP DATABASE IF EXISTS ye_weather"',
        { timeout: 10_000 }
      );
      await execShell(
        'youeye-postgres',
        'psql -U youeye -c "DROP USER IF EXISTS ye_weather"',
        { timeout: 10_000 }
      );
    } catch (err) {
      console.error('[native-uninstall] PostgreSQL cleanup failed for Weather:', err);
    }
  }

  // Clean up PostgreSQL database for Translate
  if (appId === 'ye-translate' || appId === 'translate') {
    try {
      await execShell(
        'youeye-postgres',
        'psql -U youeye -c "DROP DATABASE IF EXISTS ye_translate"',
        { timeout: 10_000 }
      );
      await execShell(
        'youeye-postgres',
        'psql -U youeye -c "DROP USER IF EXISTS ye_translate"',
        { timeout: 10_000 }
      );
    } catch (err) {
      console.error('[native-uninstall] PostgreSQL cleanup failed for Translate:', err);
    }
  }

  // Stop and delete container
  if (await containerExists(containerName)) {
    try {
      const stopResult = await incusRequest<Record<string, unknown>>(
        'PUT',
        `/1.0/instances/${containerName}/state`,
        { action: 'stop', force: true }
      );
      if (stopResult.type === 'async' && stopResult.operation) {
        await waitForIncusOp(String(stopResult.operation), 30);
      }
    } catch {
      // May already be stopped — continue to deletion
    }

    const delResult = await incusRequest<Record<string, unknown>>(
      'DELETE',
      `/1.0/instances/${containerName}`
    );
    if (delResult.type === 'async' && delResult.operation) {
      await waitForIncusOp(String(delResult.operation), 60);
    }
  }
}

async function waitForIncusOp(operationPath: string, timeoutSeconds: number): Promise<void> {
  const waitPath = `${operationPath}/wait?timeout=${timeoutSeconds}`;
  await incusRequest<Record<string, unknown>>('GET', waitPath, undefined, {
    timeout: (timeoutSeconds + 30) * 1000,
  });
}
