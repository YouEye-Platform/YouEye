/**
 * SSO Setup Logic
 *
 * Creates the OAuth2 Provider and Application in Authentik
 * so that the Control Panel can use SSO login via subdomain.
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
  // DELETE returns 204 with no body
  if (res.status === 204) return {} as T;
  return res.json() as Promise<T>;
}

/**
 * Check all prerequisites for SSO setup
 */
export async function checkSSOPrerequisites(): Promise<{
  domain: string | null;
  authentikSubdomain: string | null;
  controlSubdomain: string | null;
  authentikHealthy: boolean;
  ssoConfigured: boolean;
  authentikUrl: string | null;
  controlUrl: string | null;
}> {
  let domain: string | null = null;
  let authentikSubdomain: string | null = null;
  let controlSubdomain: string | null = null;
  let authentikHealthy = false;
  let ssoConfigured = false;
  let authentikUrl: string | null = null;
  let controlUrl: string | null = null;

  // Check if SSO is already configured via Spine
  try {
    const ssoStatus = await spineClient.getControlSSO();
    ssoConfigured = ssoStatus.configured;
    if (ssoConfigured) {
      authentikUrl = ssoStatus.authentik_url || null;
    }
  } catch {
    // Not configured
  }

  // Get domain from Caddy
  try {
    const caddyIP = await getContainerIP('youeye-caddy');
    if (caddyIP) {
      const configRes = await fetch(`http://${caddyIP}:2019/config/apps/http/servers/`);
      if (configRes.ok) {
        const servers = await configRes.json();
        // Look through all routes for container hostnames
        for (const [, server] of Object.entries(servers as Record<string, { routes?: Array<{ match?: Array<{ host?: string[] }>; handle?: Array<{ handler?: string; upstreams?: Array<{ dial?: string }> }> }> }>)) {
          const srv = server as { routes?: Array<{ match?: Array<{ host?: string[] }>; handle?: Array<{ handler?: string; upstreams?: Array<{ dial?: string }> }> }> };
          for (const route of srv.routes || []) {
            const hosts = route.match?.[0]?.host || [];
            const upstreams = route.handle?.[0]?.upstreams || route.handle?.[0]?.handler === 'subroute'
              ? [] : [];

            // Check reverse_proxy handler for container targets
            for (const handler of route.handle || []) {
              // Direct reverse_proxy
              if (handler.handler === 'reverse_proxy' && handler.upstreams) {
                const dial = handler.upstreams[0]?.dial || '';
                if (dial.includes('youeye-authentik') && hosts.length > 0) {
                  authentikSubdomain = hosts[0];
                }
                if (dial.includes('youeye-control') && hosts.length > 0) {
                  controlSubdomain = hosts[0];
                }
              }
              // Subroute handler (used by setContainerRoute)
              const subroute = handler as unknown as { handler?: string; routes?: Array<{ handle?: Array<{ handler?: string; upstreams?: Array<{ dial?: string }> }> }> };
              if (subroute.handler === 'subroute' && subroute.routes) {
                for (const sr of subroute.routes) {
                  for (const sh of sr.handle || []) {
                    if (sh.handler === 'reverse_proxy' && sh.upstreams) {
                      const dial = sh.upstreams[0]?.dial || '';
                      if (dial.includes('youeye-authentik') && hosts.length > 0) {
                        authentikSubdomain = hosts[0];
                      }
                      if (dial.includes('youeye-control') && hosts.length > 0) {
                        controlSubdomain = hosts[0];
                      }
                    }
                  }
                }
              }
            }

            // Extract base domain from any hostname
            if (!domain && hosts.length > 0) {
              const parts = hosts[0].split('.');
              if (parts.length >= 2) {
                domain = parts.slice(-2).join('.');
              }
            }
          }
        }
      }
    }
  } catch (e) {
    console.error('Failed to check Caddy config:', e);
  }

  if (authentikSubdomain) {
    authentikUrl = `https://${authentikSubdomain}`;
  }
  if (controlSubdomain) {
    controlUrl = `https://${controlSubdomain}`;
  }

  // Check Authentik health
  try {
    const config = await getAuthentikConfig();
    const res = await fetch(`${config.url}/-/health/ready/`);
    authentikHealthy = res.ok;
  } catch {
    authentikHealthy = false;
  }

  return {
    domain,
    authentikSubdomain,
    controlSubdomain,
    authentikHealthy,
    ssoConfigured,
    authentikUrl,
    controlUrl,
  };
}

/**
 * Execute SSO setup:
 * 1. Create groups scope mapping
 * 2. Create OAuth2 provider
 * 3. Create application
 * 4. Configure Spine with env vars
 */
export async function setupSSO(params: {
  authentikExternalUrl: string;
  controlExternalUrl: string;
}): Promise<{ clientId: string; clientSecret: string }> {
  const config = await getAuthentikConfig();
  const clientId = 'youeye-control';

  // 1. Find the default authorization flow
  const flows = await authentikAPI<{ results: Array<{ pk: string; slug: string }> }>(
    config, '/flows/instances/?designation=authorization'
  );
  if (!flows.results || flows.results.length === 0) {
    throw new Error('No authorization flow found in Authentik');
  }
  const authFlowPk = flows.results[0].pk;

  // 1b. Find the default invalidation flow (required in Authentik 2024.12+)
  const invalidationFlows = await authentikAPI<{ results: Array<{ pk: string; slug: string }> }>(
    config, '/flows/instances/?designation=invalidation'
  );
  // Pick provider-specific invalidation flow, or fall back to the first one
  const invalidationFlow = invalidationFlows.results?.find(f => f.slug === 'default-provider-invalidation-flow')
    || invalidationFlows.results?.[0];
  if (!invalidationFlow) {
    throw new Error('No invalidation flow found in Authentik');
  }
  const invalidationFlowPk = invalidationFlow.pk;

  // 2. Get existing scope mappings (built-in openid, email, profile)
  //    Authentik 2024.12+ uses /propertymappings/provider/scope/
  const mappings = await authentikAPI<{ results: Array<{ pk: string; scope_name: string; managed: string }> }>(
    config, '/propertymappings/provider/scope/?page_size=100'
  );
  const scopeMappingPks: string[] = [];
  for (const m of mappings.results || []) {
    if (m.managed && m.managed.startsWith('goauthentik.io/providers/oauth2/scope-')) {
      scopeMappingPks.push(m.pk);
    }
  }

  // 3. Create groups scope mapping if not exists
  let groupsMappingPk: string | null = null;
  for (const m of mappings.results || []) {
    if (m.scope_name === 'groups') {
      groupsMappingPk = m.pk;
      break;
    }
  }
  if (!groupsMappingPk) {
    const groupsMapping = await authentikAPI<{ pk: string }>(
      config, '/propertymappings/provider/scope/', 'POST', {
        name: 'YouEye Groups',
        scope_name: 'groups',
        description: 'Returns user group memberships',
        expression: 'groups = [group.name for group in request.user.ak_groups.all()]\nif "authentik Admins" in groups:\n    groups.append("admin")\nreturn {"groups": groups}',
      }
    );
    groupsMappingPk = groupsMapping.pk;
  }
  scopeMappingPks.push(groupsMappingPk);

  // 4. Generate client secret
  const secretBytes = new Uint8Array(32);
  crypto.getRandomValues(secretBytes);
  const clientSecret = Array.from(secretBytes, b => b.toString(16).padStart(2, '0')).join('');

  // 5. Check if provider already exists and delete it
  const existingProviders = await authentikAPI<{ results: Array<{ pk: number }> }>(
    config, `/providers/oauth2/?search=${encodeURIComponent(clientId)}`
  );
  for (const p of existingProviders.results || []) {
    await authentikAPI(config, `/providers/oauth2/${p.pk}/`, 'DELETE');
  }

  // Also check for existing application
  try {
    await authentikAPI(config, `/core/applications/${clientId}/`, 'DELETE');
  } catch {
    // App doesn't exist, that's fine
  }

  // 6. Build redirect URIs as array of objects (Authentik 2024.12+ format)
  const redirectUris = [
    { matching_mode: 'strict', url: `https://${new URL(params.controlExternalUrl).host}/api/auth/callback` },
    { matching_mode: 'strict', url: `http://${new URL(params.controlExternalUrl).host}/api/auth/callback` },
  ];

  // 7. Create OAuth2 Provider
  const provider = await authentikAPI<{ pk: number }>(
    config, '/providers/oauth2/', 'POST', {
      name: 'YouEye Control Panel',
      authorization_flow: authFlowPk,
      invalidation_flow: invalidationFlowPk,
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

  // 8. Create Application
  await authentikAPI(
    config, '/core/applications/', 'POST', {
      name: 'YouEye Control Panel',
      slug: clientId,
      provider: provider.pk,
      meta_launch_url: params.controlExternalUrl,
      open_in_new_tab: false,
    }
  );

  // 9. Configure Spine to inject env vars into CP container
  const internalUrl = config.url; // The internal container URL
  await spineClient.setControlSSO({
    authentik_url: params.authentikExternalUrl,
    client_id: clientId,
    client_secret: clientSecret,
    internal_url: internalUrl,
    control_url: params.controlExternalUrl,
  });

  return { clientId, clientSecret };
}

/**
 * Disable SSO: remove Authentik provider/application and Spine env vars
 */
export async function disableSSO(): Promise<void> {
  const clientId = 'youeye-control';

  // Remove from Authentik
  try {
    const config = await getAuthentikConfig();

    // Delete application first (depends on provider)
    try {
      await authentikAPI(config, `/core/applications/${clientId}/`, 'DELETE');
    } catch {
      // May not exist
    }

    // Delete provider
    const providers = await authentikAPI<{ results: Array<{ pk: number }> }>(
      config, `/providers/oauth2/?search=${encodeURIComponent(clientId)}`
    );
    for (const p of providers.results || []) {
      await authentikAPI(config, `/providers/oauth2/${p.pk}/`, 'DELETE');
    }
  } catch (e) {
    console.error('Failed to clean up Authentik resources:', e);
    // Continue anyway — still remove env vars
  }

  // Remove Spine env vars (this will restart CP)
  await spineClient.deleteControlSSO();
}
