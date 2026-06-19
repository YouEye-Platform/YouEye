/**
 * SSO Setup Logic
 *
 * Creates the OAuth2 Provider and Application in Authentik
 * so that the Control Panel can use SSO login via subdomain.
 */

import { spineClient } from '@/lib/spine/client';
import { getContainerIP } from '@/lib/incus/container-ip';
import { configureControlPanelIdentitySSO } from '@/lib/identity/core-clients';

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
      authentikUrl = ssoStatus.identity_url || null;
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
  const controlUrl = new URL(params.controlExternalUrl);
  return configureControlPanelIdentitySSO({
    controlExternalUrl: params.controlExternalUrl,
    settingsExternalUrl: `${controlUrl.protocol}//${controlUrl.host.replace(/^control\./, '')}/settings`,
  });
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
