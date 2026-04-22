/**
 * UI Management Library
 *
 * Handles the complete lifecycle of enabling/disabling the YouEye UI:
 * 1. Check UI container status via Spine  
 * 2. Create OAuth2 provider/application in Authentik for UI
 * 3. Generate environment variables
 * 4. Configure Caddy route for UI subdomain
 * 5. Start/stop UI service via Spine
 */

import { spineClient } from '@/lib/spine/client';
import { getContainerIP } from '@/lib/incus/container-ip';

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
 * Enable UI: Create Authentik OAuth2, configure Caddy, start service
 */
export async function enableUI(params: {
  domain: string;
  authentikExternalUrl: string;
}): Promise<{ success: boolean; message: string }> {
  const clientId = 'youeye-ui';
  const uiDomain = params.domain;
  const authentikConfig = await getAuthentikConfig();

  console.log('[UI] Step 1: Finding authorization flow...');
  // 1. Find authorization flow
  const flows = await authentikAPI<{ results: Array<{ pk: string; slug: string }> }>(
    authentikConfig, '/flows/instances/?designation=authorization'
  );
  if (!flows.results?.length) {
    throw new Error('No authorization flow found in Authentik');
  }
  const authFlowPk = flows.results[0].pk;
  console.log(`[UI] Found authorization flow: ${flows.results[0].slug}`);

  // 1b. Find invalidation flow
  const invalidationFlows = await authentikAPI<{ results: Array<{ pk: string; slug: string }> }>(
    authentikConfig, '/flows/instances/?designation=invalidation'
  );
  const invalidationFlow = invalidationFlows.results?.find(f => f.slug === 'default-provider-invalidation-flow')
    || invalidationFlows.results?.[0];
  if (!invalidationFlow) {
    throw new Error('No invalidation flow found in Authentik');
  }
  console.log(`[UI] Found invalidation flow: ${invalidationFlow.slug}`);

  console.log('[UI] Step 2: Getting scope mappings...');
  // 2. Get existing scope mappings
  const mappings = await authentikAPI<{ results: Array<{ pk: string; scope_name: string; managed: string }> }>(
    authentikConfig, '/propertymappings/provider/scope/?page_size=100'
  );
  const scopeMappingPks: string[] = [];
  for (const m of mappings.results || []) {
    if (m.managed?.startsWith('goauthentik.io/providers/oauth2/scope-')) {
      scopeMappingPks.push(m.pk);
    }
  }
  console.log(`[UI] Found ${scopeMappingPks.length} scope mappings`);

  console.log('[UI] Step 3: Ensuring groups scope mapping...');
  // 3. Ensure groups scope mapping exists
  let groupsMappingPk: string | null = null;
  for (const m of mappings.results || []) {
    if (m.scope_name === 'groups') {
      groupsMappingPk = m.pk;
      break;
    }
  }
  if (!groupsMappingPk) {
    const groupsMapping = await authentikAPI<{ pk: string }>(
      authentikConfig, '/propertymappings/provider/scope/', 'POST', {
        name: 'YouEye Groups',
        scope_name: 'groups',
        description: 'Returns user group memberships',
        expression: 'groups = [group.name for group in request.user.ak_groups.all()]\nif "authentik Admins" in groups:\n    groups.append("admin")\nreturn {"groups": groups}',
      }
    );
    groupsMappingPk = groupsMapping.pk;
    console.log('[UI] Created groups scope mapping');
  } else {
    console.log('[UI] Groups scope mapping already exists');
  }
  scopeMappingPks.push(groupsMappingPk);

  // 4. Generate client secret
  const secretBytes = new Uint8Array(32);
  crypto.getRandomValues(secretBytes);
  const clientSecret = Array.from(secretBytes, b => b.toString(16).padStart(2, '0')).join('');

  console.log('[UI] Step 5: Cleaning up existing Authentik resources...');
  // 5. Clean up any existing provider/application
  // Delete providers FIRST (search by client_id), then delete application.
  // This ensures orphaned providers are removed even if the app was already deleted.
  try {
    const existingProviders = await authentikAPI<{ results: Array<{ pk: number; client_id: string }> }>(
      authentikConfig, `/providers/oauth2/?search=${encodeURIComponent(clientId)}`
    );
    for (const p of existingProviders.results || []) {
      await authentikAPI(authentikConfig, `/providers/oauth2/${p.pk}/`, 'DELETE');
      console.log(`[UI] Deleted provider pk=${p.pk}`);
    }
  } catch { /* providers may not exist */ }

  try {
    await authentikAPI(authentikConfig, `/core/applications/${clientId}/`, 'DELETE');
    console.log('[UI] Deleted existing application');
  } catch { /* may not exist */ }

  // 6. Build redirect URIs
  console.log('[UI] Step 6: Building redirect URIs...');
  const redirectUris = [
    { matching_mode: 'strict', url: `https://${uiDomain}/api/auth/callback` },
    { matching_mode: 'strict', url: `http://${uiDomain}/api/auth/callback` },
  ];

  // 7. Create OAuth2 Provider
  console.log('[UI] Step 7: Creating OAuth2 provider...');
  const provider = await authentikAPI<{ pk: number }>(
    authentikConfig, '/providers/oauth2/', 'POST', {
      name: 'YouEye UI',
      authorization_flow: authFlowPk,
      invalidation_flow: invalidationFlow.pk,
      client_type: 'confidential',
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uris: redirectUris,
      property_mappings: scopeMappingPks,
      sub_mode: 'hashed_user_id',
      include_claims_in_id_token: true,
      issuer_mode: 'per_provider',
      access_code_validity: 'minutes=1',
      access_token_validity: 'minutes=5',
      refresh_token_validity: 'days=30',
    }
  );
  console.log(`[UI] Created OAuth2 provider pk=${provider.pk}`);

  // 8. Create Application
  console.log('[UI] Step 8: Creating Authentik application...');
  await authentikAPI(
    authentikConfig, '/core/applications/', 'POST', {
      name: 'YouEye UI',
      slug: clientId,
      provider: provider.pk,
      meta_launch_url: `https://${uiDomain}`,
      open_in_new_tab: false,
    }
  );
  console.log('[UI] Created Authentik application');

  // 9. Generate JWT secret
  const jwtBytes = new Uint8Array(48);
  crypto.getRandomValues(jwtBytes);
  const jwtSecret = Array.from(jwtBytes, b => b.toString(16).padStart(2, '0')).join('');

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
  await spineClient.setUISSO({
    authentik_url: params.authentikExternalUrl,
    authentik_internal_url: authentikConfig.url,
    client_id: clientId,
    client_secret: clientSecret,
    jwt_secret: jwtSecret,
    database_url: databaseUrl,
    domain: uiDomain,
    base_url: `https://${uiDomain}`,
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
