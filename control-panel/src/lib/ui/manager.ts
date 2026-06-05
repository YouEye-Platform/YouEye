/**
 * UI Management Library
 *
 * Handles the complete lifecycle of enabling/disabling the YouEye UI:
 * 1. Check UI container status via Spine  
 * 2. Create OAuth2 client in YouEye ID for UI
 * 3. Generate environment variables
 * 4. Configure Caddy route for UI subdomain
 * 5. Start/stop UI service via Spine
 */

import { spineClient } from '@/lib/spine/client';
import { getContainerIP } from '@/lib/incus/container-ip';
import { configureUIIdentitySSO } from '@/lib/identity/core-clients';

interface AuthentikConfig {
  url: string;
  token: string;
}

async function getAuthentikConfig(): Promise<AuthentikConfig> {
  const creds = await spineClient.getAuthentikCredentials();
  const ip = await getContainerIP('youeye-authentik');
  const url = ip ? `http://${ip}:9000` : creds.internal_url;
  return { url, token: creds.bootstrap_token };
}

async function authentikAPI<T>(
  config: AuthentikConfig,
  path: string,
  method: string = 'GET',
  body?: Record<string, unknown>
): Promise<T> {
  const options: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${config.token}`,
      'Content-Type': 'application/json',
    },
  };
  if (body) options.body = JSON.stringify(body);

  const res = await fetch(`${config.url}/api/v3${path}`, options);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Authentik API ${res.status}: ${text}`);
  }
  if (res.status === 204) return {} as T;
  return res.json() as Promise<T>;
}

export interface UIStatus {
  installed: boolean;
  enabled: boolean;
  containerStatus: string;
  version?: string;
  ip?: string;
  ssoConfigured: boolean;
  serviceActive: boolean;
  domain?: string;
}

/**
 * Get comprehensive UI status from Spine
 */
export async function getUIStatus(): Promise<UIStatus> {
  try {
    const status = await spineClient.status();
    const ui = status.ui;

    if (!ui || !ui.installed) {
      return {
        installed: false,
        enabled: false,
        containerStatus: 'not-installed',
        ssoConfigured: false,
        serviceActive: false,
      };
    }

    // Get SSO status from Spine
    let ssoConfigured = false;
    let serviceActive = false;
    let domain: string | undefined;
    try {
      const ssoStatus = await spineClient.getUISSO();
      ssoConfigured = ssoStatus.configured;
      serviceActive = ssoStatus.service_active;
      domain = ssoStatus.domain;
    } catch {
      // SSO endpoint might not be reachable
    }

    return {
      installed: true,
      enabled: ui.enabled,
      containerStatus: ui.status,
      version: ui.version,
      ip: ui.ip,
      ssoConfigured,
      serviceActive,
      domain,
    };
  } catch {
    return {
      installed: false,
      enabled: false,
      containerStatus: 'error',
      ssoConfigured: false,
      serviceActive: false,
    };
  }
}

/**
 * Enable UI: Create YouEye ID OAuth2 client, configure Caddy, start service
 */
export async function enableUI(params: {
  domain: string;
  authentikExternalUrl: string;
}): Promise<{ success: boolean; message: string }> {
  const uiDomain = params.domain;

  // 10. Get PostgreSQL credentials for DATABASE_URL
  console.log('[UI] Step 10: Getting PostgreSQL credentials...');
  const pgCreds = await spineClient.getPostgresCredentials();
  const databaseUrl = `postgresql://${pgCreds.user}:${encodeURIComponent(pgCreds.password)}@${pgCreds.host}:${pgCreds.port}/youeye_ui`;
  console.log(`[UI] Database URL constructed for host ${pgCreds.host}`);

  // 11. Configure Caddy route for UI domain
  console.log('[UI] Step 11: Configuring Caddy route...');
  const uiIP = await getContainerIP('youeye-ui');
  if (uiIP) {
    const caddyIP = await getContainerIP('youeye-caddy');
    if (caddyIP) {
      try {
        await configureCaddyUIRoute(caddyIP, uiDomain, uiIP);
        console.log(`[UI] Caddy route configured: ${uiDomain} -> ${uiIP}:3000`);
      } catch (e) {
        console.error('[UI] Failed to configure Caddy route:', e);
        // Continue anyway — user can fix Caddy manually
      }
    } else {
      console.warn('[UI] Could not get Caddy container IP');
    }
  } else {
    console.warn('[UI] Could not get UI container IP for Caddy route');
  }

  // 12. Configure Spine to set env vars and start UI service
  console.log('[UI] Step 12: Configuring Spine env vars and starting service...');
  await configureUIIdentitySSO({
    uiExternalUrl: `https://${uiDomain}`,
    databaseUrl,
  });
  console.log('[UI] Spine SSO configured and service started');

  return {
    success: true,
    message: `UI enabled at https://${uiDomain}`,
  };
}

/**
 * Disable UI: Remove Authentik resources, stop service, remove Caddy route
 */
export async function disableUI(): Promise<void> {
  const clientId = 'youeye-ui';

  // Remove from Authentik
  console.log('[UI] Disabling: Removing Authentik resources...');
  try {
    const authentikConfig = await getAuthentikConfig();
    try {
      await authentikAPI(authentikConfig, `/core/applications/${clientId}/`, 'DELETE');
      console.log('[UI] Deleted Authentik application');
    } catch { /* may not exist */ }

    const providers = await authentikAPI<{ results: Array<{ pk: number }> }>(
      authentikConfig, `/providers/oauth2/?search=${encodeURIComponent(clientId)}`
    );
    for (const p of providers.results || []) {
      await authentikAPI(authentikConfig, `/providers/oauth2/${p.pk}/`, 'DELETE');
      console.log(`[UI] Deleted provider pk=${p.pk}`);
    }
  } catch (e) {
    console.error('[UI] Failed to clean up Authentik resources:', e);
  }

  // Remove Caddy route
  console.log('[UI] Disabling: Removing Caddy route...');
  try {
    const caddyIP = await getContainerIP('youeye-caddy');
    const uiIP = await getContainerIP('youeye-ui');
    if (caddyIP) {
      await removeCaddyUIRoute(caddyIP, uiIP);
      console.log('[UI] Caddy route removed');
    }
  } catch (e) {
    console.error('[UI] Failed to remove Caddy route:', e);
  }

  // Stop service and remove env vars via Spine
  console.log('[UI] Disabling: Stopping UI service via Spine...');
  await spineClient.deleteUISSO();
  console.log('[UI] UI disabled successfully');
}

/**
 * Create a youeye-ui database in PostgreSQL if it doesn't exist
 */
export async function ensureUIDatabase(): Promise<void> {
  const { execShell } = await import('@/lib/incus/server');

  // Check if database exists
  const checkResult = await execShell('youeye-postgres',
    "psql -U youeye -d postgres -tAc \"SELECT 1 FROM pg_database WHERE datname='youeye_ui'\""
  );

  if (checkResult.stdout?.trim() !== '1') {
    // Create the database
    await execShell('youeye-postgres',
      "psql -U youeye -d postgres -c 'CREATE DATABASE youeye_ui OWNER youeye'"
    );
  }
}

/**
 * Configure Caddy to route UI subdomain to the UI container
 */
async function configureCaddyUIRoute(
  caddyIP: string,
  uiSubdomain: string,
  uiContainerIP: string
): Promise<void> {
  const caddyAdminURL = `http://${caddyIP}:2019`;

  // Get current config
  const configRes = await fetch(`${caddyAdminURL}/config/`);
  if (!configRes.ok) throw new Error('Failed to get Caddy config');
  const config = await configRes.json();

  // Build the UI route
  const uiRoute = {
    match: [{ host: [uiSubdomain] }],
    handle: [{
      handler: 'subroute',
      routes: [{
        handle: [{
          handler: 'reverse_proxy',
          upstreams: [{ dial: `${uiContainerIP}:3000` }],
        }],
      }],
    }],
  };

  // Ensure apps.http.servers.srv0 structure exists
  if (!config.apps) config.apps = {};
  if (!config.apps.http) config.apps.http = {};
  if (!config.apps.http.servers) config.apps.http.servers = {};
  if (!config.apps.http.servers.srv0) {
    config.apps.http.servers.srv0 = {
      listen: [':443', ':80'],
      routes: [],
    };
  }

  const routes = config.apps.http.servers.srv0.routes || [];

  // Remove existing UI route if any
  const filteredRoutes = routes.filter((r: { match?: Array<{ host?: string[] }> }) => {
    const hosts = r.match?.[0]?.host || [];
    return !hosts.includes(uiSubdomain);
  });

  // Add the new route at the beginning
  filteredRoutes.unshift(uiRoute);
  config.apps.http.servers.srv0.routes = filteredRoutes;

  // Ensure the UI domain is in the TLS automation subjects
  if (!config.apps.tls) config.apps.tls = {};
  if (!config.apps.tls.automation) config.apps.tls.automation = {};
  if (!config.apps.tls.automation.policies) config.apps.tls.automation.policies = [];

  // Check if there's an existing ACME policy and add the UI domain to it
  const existingPolicy = config.apps.tls.automation.policies.find(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (p: any) => p.subjects && p.issuers
  );
  if (existingPolicy) {
    if (!existingPolicy.subjects.includes(uiSubdomain)) {
      existingPolicy.subjects.push(uiSubdomain);
    }
  }

  // Apply config
  const loadRes = await fetch(`${caddyAdminURL}/load`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });

  if (!loadRes.ok) {
    const text = await loadRes.text();
    throw new Error(`Failed to apply Caddy config: ${text}`);
  }
}

/**
 * Remove the UI route from Caddy
 */
async function removeCaddyUIRoute(caddyIP: string, uiIP: string | null): Promise<void> {
  const caddyAdminURL = `http://${caddyIP}:2019`;

  const configRes = await fetch(`${caddyAdminURL}/config/`);
  if (!configRes.ok) return;
  const config = await configRes.json();

  const routes = config?.apps?.http?.servers?.srv0?.routes;
  if (!routes) return;

  // Remove routes that proxy to the UI container IP
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config.apps.http.servers.srv0.routes = routes.filter((r: any) => {
    const handlers = r.handle || [];
    for (const h of handlers) {
      if (h.handler === 'subroute' && h.routes) {
        for (const sr of h.routes) {
          for (const sh of sr.handle || []) {
            if (sh.handler === 'reverse_proxy' && sh.upstreams?.[0]?.dial) {
              const dial = sh.upstreams[0].dial;
              if ((uiIP && dial.startsWith(uiIP + ':')) || dial.includes('youeye-ui')) {
                return false;
              }
            }
          }
        }
      }
      if (h.handler === 'reverse_proxy' && h.upstreams?.[0]?.dial) {
        const dial = h.upstreams[0].dial;
        if ((uiIP && dial.startsWith(uiIP + ':')) || dial.includes('youeye-ui')) {
          return false;
        }
      }
    }
    return true;
  });

  await fetch(`${caddyAdminURL}/load`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
}
