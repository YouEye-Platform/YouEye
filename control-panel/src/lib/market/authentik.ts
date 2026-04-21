/**
 * Authentik CRUD operations for market app SSO integration.
 * Handles OAuth2 provider/application management in Authentik.
 *
 * Extracted from temp-market/sso-setup.ts to be the permanent home
 * for Authentik integration used by the YAML-driven SSO engine.
 */

import { spineClient } from '@/lib/spine/client';
import { getContainerIP } from '@/lib/incus/container-ip';
import { settingsService } from '@/lib/settings/service';

interface AuthentikConfig {
  url: string;
  token: string;
}

export async function getAuthentikConfig(): Promise<AuthentikConfig> {
  const creds = await spineClient.getAuthentikCredentials();
  const ip = await getContainerIP('youeye-authentik');
  const url = ip ? `http://${ip}:9000` : creds.internal_url;
  return { url, token: creds.bootstrap_token };
}

export async function authentikAPI<T>(
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

/**
 * Check if Authentik is available and healthy for SSO integration.
 */
export async function isAuthentikAvailable(): Promise<boolean> {
  try {
    const config = await getAuthentikConfig();
    const res = await fetch(`${config.url}/-/health/ready/`, {
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Get the external Authentik URL from Caddy routes, with config-based fallback.
 *
 * Strategy:
 * 1. Search Caddy routes for a reverse_proxy targeting youeye-authentik
 *    - If the route has a host matcher, use that hostname
 *    - If the route exists but has no host matcher, fall back to config
 * 2. Fallback: construct URL from platform config (domain + auth subdomain)
 */
export async function getAuthentikExternalUrl(): Promise<string | null> {
  // Try Caddy routes first
  try {
    const caddyIP = await getContainerIP('youeye-caddy');
    if (caddyIP) {
      const res = await fetch(`http://${caddyIP}:2019/config/apps/http/servers/`);
      if (res.ok) {
        const servers = await res.json();
        let authentikRouteExists = false;

        for (const [, server] of Object.entries(
          servers as Record<string, { routes?: Array<{ match?: Array<{ host?: string[] }>; handle?: Array<Record<string, unknown>> }> }>
        )) {
          for (const route of server.routes || []) {
            const hosts: string[] = route.match?.[0]?.host || [];
            for (const handler of route.handle || []) {
              const h = handler as Record<string, unknown>;
              if (h.handler === 'reverse_proxy' && Array.isArray(h.upstreams)) {
                const dial = String((h.upstreams as Array<{ dial?: string }>)[0]?.dial || '');
                if (dial.includes('youeye-authentik')) {
                  if (hosts.length > 0) return `https://${hosts[0]}`;
                  authentikRouteExists = true;
                }
              }
              if (h.handler === 'subroute' && Array.isArray(h.routes)) {
                for (const sr of h.routes as Array<{ handle?: Array<Record<string, unknown>> }>) {
                  for (const sh of sr.handle || []) {
                    if (sh.handler === 'reverse_proxy' && Array.isArray(sh.upstreams)) {
                      const dial = String((sh.upstreams as Array<{ dial?: string }>)[0]?.dial || '');
                      if (dial.includes('youeye-authentik')) {
                        if (hosts.length > 0) return `https://${hosts[0]}`;
                        authentikRouteExists = true;
                      }
                    }
                  }
                }
              }
            }
          }
        }

        // Authentik route exists in Caddy but has no host matcher — fall through to config
        if (authentikRouteExists) {
          console.log('[authentik] Route found in Caddy without host matcher, falling back to config');
        }
      }
    }
  } catch {
    // Caddy not available — fall through to config
  }

  // Fallback: construct URL from platform config
  try {
    const config = await settingsService.getRaw();
    if (config.domain) {
      const authSub = config.subdomains?.auth || 'auth';
      return `https://${authSub}.${config.domain}`;
    }
  } catch {
    // Config not available
  }

  return null;
}

/**
 * Create an OAuth2 provider and application in Authentik for a market app.
 */
export async function createAuthentikOAuth2App(params: {
  slug: string;
  name: string;
  redirectUris: Array<{ matching_mode: string; url: string }>;
  launchUrl: string;
  /** Use implicit consent to avoid BUG-004 consent screen friction */
  implicitConsent?: boolean;
}): Promise<{ clientId: string; clientSecret: string }> {
  const config = await getAuthentikConfig();
  const clientId = params.slug;

  // Find authorization flow — prefer implicit-consent (no consent prompt) for self-hosted
  const flows = await authentikAPI<{ results: Array<{ pk: string; slug: string }> }>(
    config,
    '/flows/instances/?designation=authorization'
  );
  if (!flows.results?.length) throw new Error('No authorization flow found');
  const implicitFlow = flows.results.find((f) => f.slug === 'default-provider-authorization-implicit-consent');
  const authFlowPk = (implicitFlow ?? flows.results[0]).pk;

  // Find invalidation flow
  const invalidationFlows = await authentikAPI<{ results: Array<{ pk: string; slug: string }> }>(
    config,
    '/flows/instances/?designation=invalidation'
  );
  const invalidationFlow =
    invalidationFlows.results?.find((f) => f.slug === 'default-provider-invalidation-flow') ||
    invalidationFlows.results?.[0];
  if (!invalidationFlow) throw new Error('No invalidation flow found');

  // Get scope mappings — include built-in OAuth2 scopes AND custom ones (e.g. YouEye Groups)
  const mappings = await authentikAPI<{
    results: Array<{ pk: string; scope_name: string; managed: string | null; name: string }>;
  }>(config, '/propertymappings/provider/scope/?page_size=100');
  const scopeMappingPks: string[] = [];
  for (const m of mappings.results || []) {
    if (m.managed?.startsWith('goauthentik.io/providers/oauth2/scope-') || !m.managed) {
      scopeMappingPks.push(m.pk);
    }
  }

  // Generate client secret
  const secretBytes = new Uint8Array(32);
  crypto.getRandomValues(secretBytes);
  const clientSecret = Array.from(secretBytes, (b) => b.toString(16).padStart(2, '0')).join('');

  // Delete existing provider/app
  try {
    await authentikAPI(config, `/core/applications/${clientId}/`, 'DELETE');
  } catch {
    /* may not exist */
  }
  try {
    const allProviders = await authentikAPI<{ results: Array<{ pk: number; client_id?: string; name?: string }> }>(
      config,
      '/providers/oauth2/?page_size=100'
    );
    for (const p of allProviders.results || []) {
      if (p.client_id === clientId || p.name === params.name) {
        try {
          await authentikAPI(config, `/providers/oauth2/${p.pk}/`, 'DELETE');
        } catch {
          /* individual delete may fail */
        }
      }
    }
  } catch {
    /* listing may fail */
  }

  // Create OAuth2 Provider
  const provider = await authentikAPI<{ pk: number }>(config, '/providers/oauth2/', 'POST', {
    name: params.name,
    authorization_flow: authFlowPk,
    invalidation_flow: invalidationFlow.pk,
    client_type: 'confidential',
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uris: params.redirectUris,
    property_mappings: scopeMappingPks,
    sub_mode: 'hashed_user_id',
    include_claims_in_id_token: true,
    issuer_mode: 'per_provider',
    access_code_validity: 'minutes=1',
    access_token_validity: 'minutes=5',
    refresh_token_validity: 'days=30',
  });

  // Create Application
  // policy_engine_mode: "any" = implicit consent (skips consent screen — BUG-004 fix)
  // policy_engine_mode: "all" = explicit consent (default Authentik behavior)
  await authentikAPI(config, '/core/applications/', 'POST', {
    name: params.name,
    slug: clientId,
    provider: provider.pk,
    meta_launch_url: params.launchUrl,
    open_in_new_tab: true,
    ...(params.implicitConsent ? { policy_engine_mode: 'any' } : {}),
  });

  return { clientId, clientSecret };
}

/**
 * Create an Authentik forward-auth proxy provider and application.
 * Used for apps without native OAuth2 — Caddy's forward_auth directive
 * checks the user's Authentik session before proxying to the app.
 */
export async function createAuthentikForwardAuthApp(params: {
  slug: string;
  name: string;
  externalHost: string;
}): Promise<{ providerId: number; slug: string }> {
  const config = await getAuthentikConfig();

  // Find authorization flow (implicit consent — no prompt for self-hosted)
  const flows = await authentikAPI<{ results: Array<{ pk: string; slug: string }> }>(
    config,
    '/flows/instances/?designation=authorization'
  );
  if (!flows.results?.length) throw new Error('No authorization flow found');
  const implicitFlow = flows.results.find((f) => f.slug === 'default-provider-authorization-implicit-consent');
  const authFlowPk = (implicitFlow ?? flows.results[0]).pk;

  // Find invalidation flow (required by Authentik for proxy providers)
  const invalidationFlows = await authentikAPI<{ results: Array<{ pk: string; slug: string }> }>(
    config,
    '/flows/instances/?designation=invalidation'
  );
  const invalidationFlow =
    invalidationFlows.results?.find((f) => f.slug === 'default-provider-invalidation-flow') ||
    invalidationFlows.results?.[0];
  if (!invalidationFlow) throw new Error('No invalidation flow found');

  // Find authentication flow
  const authFlows = await authentikAPI<{ results: Array<{ pk: string; slug: string }> }>(
    config,
    '/flows/instances/?designation=authentication'
  );
  const authenticationFlowPk = authFlows.results?.[0]?.pk;

  // Delete existing provider/app if they exist
  try {
    await authentikAPI(config, `/core/applications/${params.slug}/`, 'DELETE');
  } catch { /* may not exist */ }
  try {
    const allProviders = await authentikAPI<{ results: Array<{ pk: number; name?: string }> }>(
      config,
      '/providers/proxy/?page_size=100'
    );
    for (const p of allProviders.results || []) {
      if (p.name === params.name) {
        try { await authentikAPI(config, `/providers/proxy/${p.pk}/`, 'DELETE'); } catch {}
      }
    }
  } catch { /* listing may fail */ }

  // Create proxy provider in forward_single mode
  const providerBody: Record<string, unknown> = {
    name: params.name,
    authorization_flow: authFlowPk,
    invalidation_flow: invalidationFlow.pk,
    external_host: params.externalHost,
    mode: 'forward_single',
    access_token_validity: 'hours=24',
  };
  if (authenticationFlowPk) {
    providerBody.authentication_flow = authenticationFlowPk;
  }
  const provider = await authentikAPI<{ pk: number }>(config, '/providers/proxy/', 'POST', providerBody);

  // Create application
  await authentikAPI(config, '/core/applications/', 'POST', {
    name: params.name,
    slug: params.slug,
    provider: provider.pk,
    meta_launch_url: params.externalHost,
    policy_engine_mode: 'any',
  });

  // Add provider to embedded outpost and ensure external URL is configured
  try {
    const outposts = await authentikAPI<{ results: Array<{ pk: string; name: string; providers: number[]; config: Record<string, unknown> }> }>(
      config,
      '/outposts/instances/?page_size=50'
    );
    const embedded = outposts.results?.find((o) => o.name.toLowerCase().includes('embedded'));
    if (embedded) {
      const updatedProviders = [...new Set([...embedded.providers, provider.pk])];
      const patchBody: Record<string, unknown> = { providers: updatedProviders };

      // Ensure outpost has the external Authentik URL so forward-auth redirects
      // go to auth.domain instead of the internal container IP
      if (!embedded.config?.authentik_host) {
        const externalUrl = await getAuthentikExternalUrl();
        if (externalUrl) {
          patchBody.config = {
            ...embedded.config,
            authentik_host: externalUrl,
            authentik_host_browser: externalUrl,
            authentik_host_insecure: true,
          };
        }
      }

      await authentikAPI(config, `/outposts/instances/${embedded.pk}/`, 'PATCH', patchBody);
    }
  } catch (err) {
    console.warn('[authentik] Failed to add provider to embedded outpost:', err);
  }

  return { providerId: provider.pk, slug: params.slug };
}

/**
 * Remove an Authentik forward-auth proxy provider and application.
 */
export async function removeAuthentikForwardAuthApp(slug: string): Promise<void> {
  try {
    const config = await getAuthentikConfig();
    try {
      await authentikAPI(config, `/core/applications/${slug}/`, 'DELETE');
    } catch { /* may not exist */ }
    try {
      const allProviders = await authentikAPI<{ results: Array<{ pk: number; name?: string }> }>(
        config,
        '/providers/proxy/?page_size=100'
      );
      for (const p of allProviders.results || []) {
        if (p.name?.includes(slug) || p.name?.includes('YouEye -')) {
          // Match by checking the application still references this slug
          try { await authentikAPI(config, `/providers/proxy/${p.pk}/`, 'DELETE'); } catch {}
        }
      }
    } catch { /* listing may fail */ }
  } catch (err) {
    console.error(`[Market SSO] Failed to remove Authentik forward-auth app ${slug}:`, err);
  }
}

/**
 * Remove an Authentik OAuth2 application and provider for a market app.
 */
export async function removeAuthentikOAuth2App(slug: string): Promise<void> {
  try {
    const config = await getAuthentikConfig();

    try {
      await authentikAPI(config, `/core/applications/${slug}/`, 'DELETE');
    } catch {
      /* may not exist */
    }

    try {
      const allProviders = await authentikAPI<{ results: Array<{ pk: number; client_id?: string }> }>(
        config,
        '/providers/oauth2/?page_size=100'
      );
      for (const p of allProviders.results || []) {
        if (p.client_id === slug) {
          try {
            await authentikAPI(config, `/providers/oauth2/${p.pk}/`, 'DELETE');
          } catch {
            /* individual delete may fail */
          }
        }
      }
    } catch {
      /* listing may fail */
    }
  } catch (err) {
    console.error(`[Market SSO] Failed to remove Authentik app ${slug}:`, err);
  }
}
