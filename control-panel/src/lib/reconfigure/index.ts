/**
 * Server Reconfiguration Engine
 *
 * Handles changing YouEye's domain, site name, and subdomains after initial setup.
 * Orchestrates updates across all systems: youeye.yaml, Caddy, Pi-Hole, Authentik,
 * Control Panel SSO, UI SSO, and all installed market apps.
 *
 * Key design decision: The CP orchestrates everything except its own restart.
 * After all changes are applied, it schedules a delayed restart via Spine.
 */

import { settingsService } from '@/lib/settings';
import { spineClient } from '@/lib/spine/client';
import * as caddy from '@/lib/caddy/client';
import { setDomainDNS } from '@/lib/apps/pihole-api';
import { listInstalledApps, saveInstallMetadata } from '@/lib/market/metadata';
import { getContainerIP } from '@/lib/incus/container-ip';
import { resolveVariables, resolveEnvironment } from '@/lib/market/variables';
import { writeAllConfigFiles } from '@/lib/market/config-writer';
import { incusRequest } from '@/lib/incus/server';
import type { InstallMetadata } from '@/lib/market/types';

export interface ReconfigureRequest {
  site_name?: string;
  domain?: string;
  subdomains?: Record<string, string>;
  site_name_style?: Record<string, unknown>;
  authentik_name?: string;
}

export interface ReconfigureEvent {
  step: string;
  status: 'running' | 'done' | 'error';
  message?: string;
}

export type ReconfigureEventCallback = (event: ReconfigureEvent) => void;

// ─── Authentik Helpers ─────────────────────────────────────

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

// ─── Caddy Bulk Update ────────────────────────────────────

/**
 * Update all Caddy route hostnames from old domain to new domain.
 * Also updates TLS subjects.
 */
async function updateCaddyDomain(
  oldDomain: string,
  newDomain: string,
  oldSubdomains: Record<string, string>,
  newSubdomains: Record<string, string>
): Promise<void> {
  const config = await caddy.getConfig();
  const servers = config.apps?.http?.servers || {};

  // Build a map of old hostname -> new hostname
  const hostnameMap = new Map<string, string>();

  // Core service subdomains
  for (const [key, oldSub] of Object.entries(oldSubdomains)) {
    const newSub = newSubdomains[key] || oldSub;
    const oldHost = oldSub ? `${oldSub}.${oldDomain}` : oldDomain;
    const newHost = newSub ? `${newSub}.${newDomain}` : newDomain;
    hostnameMap.set(oldHost, newHost);
  }

  // Also map bare domain
  hostnameMap.set(oldDomain, newDomain);

  // Walk all routes and update host matchers
  for (const server of Object.values(servers)) {
    for (const route of server.routes || []) {
      if (!route.match) continue;
      for (const m of route.match) {
        if (!m.host) continue;
        m.host = m.host.map((h: string) => {
          // Direct map match
          if (hostnameMap.has(h)) return hostnameMap.get(h)!;
          // Suffix match for app subdomains (e.g., searx.olddomain -> searx.newdomain)
          if (h.endsWith(`.${oldDomain}`)) {
            const sub = h.slice(0, -(oldDomain.length + 1));
            return `${sub}.${newDomain}`;
          }
          return h;
        });
      }
    }
  }

  // Update TLS subjects
  if (config.apps?.tls?.automation?.policies) {
    for (const policy of config.apps.tls.automation.policies) {
      if (!policy.subjects) continue;
      policy.subjects = policy.subjects.map((s: string) => {
        if (s === `*.${oldDomain}`) return `*.${newDomain}`;
        if (s === oldDomain) return newDomain;
        if (s.endsWith(`.${oldDomain}`)) {
          const sub = s.slice(0, -(oldDomain.length + 1));
          return `${sub}.${newDomain}`;
        }
        return s;
      });
    }
  }

  await caddy.setConfig(config);
}

// ─── Authentik Provider Update ────────────────────────────

/**
 * Update redirect URIs and launch URL for an Authentik OAuth2 provider/application.
 * hostnameMap optionally maps old full hostnames to new ones (for subdomain changes).
 */
async function updateAuthentikProvider(
  akConfig: AuthentikConfig,
  clientId: string,
  oldDomain: string,
  newDomain: string,
  hostnameMap?: Map<string, string>
): Promise<void> {
  // Find the provider
  const providers = await authentikAPI<{
    results: Array<{ pk: number; client_id: string; redirect_uris: Array<{ matching_mode: string; url: string }> }>;
  }>(akConfig, `/providers/oauth2/?client_id=${encodeURIComponent(clientId)}`);

  for (const provider of providers.results || []) {
    if (provider.client_id !== clientId) continue;

    // Update redirect URIs — apply hostname replacements first, then domain replacement
    const newUris = provider.redirect_uris.map((uri) => {
      let url = uri.url;
      if (hostnameMap) {
        for (const [oldHost, newHost] of hostnameMap) {
          url = url.replace(new RegExp(escapeRegex(oldHost), 'g'), newHost);
        }
      }
      // Fall back to domain-only replacement for anything not caught by hostname map
      url = url.replace(new RegExp(escapeRegex(oldDomain), 'g'), newDomain);
      return { ...uri, url };
    });

    await authentikAPI(akConfig, `/providers/oauth2/${provider.pk}/`, 'PATCH', {
      redirect_uris: newUris,
    });
  }

  // Update application launch URL
  try {
    const app = await authentikAPI<{ meta_launch_url: string }>(
      akConfig,
      `/core/applications/${clientId}/`
    );
    if (app.meta_launch_url?.includes(oldDomain)) {
      await authentikAPI(akConfig, `/core/applications/${clientId}/`, 'PATCH', {
        meta_launch_url: app.meta_launch_url.replace(
          new RegExp(escapeRegex(oldDomain), 'g'),
          newDomain
        ),
      });
    }
  } catch {
    // Application may not exist
  }
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── App Domain Update ────────────────────────────────────

/**
 * Fetch an app manifest from the YE-AppMarket repo on Gitea.
 */
async function fetchAppManifest(appId: string): Promise<Record<string, unknown> | null> {
  try {
    const { parse } = await import('yaml');
    const url = `https://git.byka.wtf/potemsla/YE-AppMarket/raw/branch/main/apps/${appId}.yaml`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const text = await res.text();
    return parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Update a single installed market app's domain.
 * Updates: container env vars, config files, Caddy route, Authentik SSO, metadata.
 */
async function updateInstalledApp(
  meta: InstallMetadata,
  oldDomain: string,
  newDomain: string,
  akConfig: AuthentikConfig
): Promise<void> {
  const appId = meta.appId;
  const oldUrl = `https://${meta.subdomain}.${oldDomain}`;
  const newUrl = `https://${meta.subdomain}.${newDomain}`;

  // Load manifest to know which env vars and config files reference the domain
  const rawManifest = await fetchAppManifest(appId);

  if (rawManifest) {
    const containers = (rawManifest as { containers?: Array<Record<string, unknown>> }).containers || [];
    const configFiles = (rawManifest as { configFiles?: Array<Record<string, unknown>> }).configFiles || [];

    // Build variable context for new domain
    const secrets: Record<string, string> = {};
    // Read existing secrets
    const secretSpecs = (rawManifest as { secrets?: Array<{ name: string; file: string }> }).secrets || [];
    for (const sec of secretSpecs) {
      try {
        const { readFile } = await import('fs/promises');
        const val = await readFile(`/var/lib/youeye/app-${appId}/${sec.file}`, 'utf-8');
        secrets[sec.name] = val.trim();
      } catch {
        // Secret may not exist
      }
    }

    const ctx = {
      app: { id: appId },
      install: {
        url: newUrl,
        subdomain: meta.subdomain,
        domain: newDomain,
      },
      secrets,
      container: { ip: '', port: 0 },
      sso: { clientId: meta.ssoClientId || '', clientSecret: '' },
      authentik: { externalUrl: '', internalUrl: '', name: '' },
    };

    // Update container environment variables with new domain values
    for (const containerSpec of containers) {
      const env = (containerSpec as { environment?: Record<string, string> }).environment || {};
      const containerName = containers.length === 1
        ? `app-${appId}`
        : `app-${appId}-${(containerSpec as { name: string }).name}`;

      // Check if any env vars reference install.url or install.domain
      const envUpdates: Record<string, string> = {};
      for (const [key, template] of Object.entries(env)) {
        if (template.includes('${install.') || template.includes('${app.')) {
          try {
            const resolved = resolveVariables(template, ctx);
            envUpdates[`environment.${key}`] = resolved;
          } catch {
            // Variable resolution failed — skip
          }
        }
      }

      if (Object.keys(envUpdates).length > 0) {
        await incusRequest('PATCH', `/1.0/instances/${containerName}`, {
          config: envUpdates,
        });
      }
    }

    // Regenerate config files with new domain
    if (configFiles.length > 0) {
      try {
        const typedConfigFiles = configFiles.map((cf) => ({
          path: cf.path as string,
          permission: (cf.permission as string) || '0o644',
          directoryPermission: (cf.directoryPermission as string) || '0o700',
          template: cf.template as string,
        }));
        await writeAllConfigFiles(typedConfigFiles, ctx);
      } catch (err) {
        console.error(`[Reconfigure] Failed to write config files for ${appId}:`, err);
      }
    }

    // Restart app containers to pick up new env vars
    for (const containerName of meta.containers) {
      try {
        await incusRequest('PUT', `/1.0/instances/${containerName}/state`, {
          action: 'restart',
          force: true,
          timeout: 30,
        });
      } catch {
        // Container may not be running
      }
    }

    // Wait for the primary container to be ready before running SSO steps
    if (meta.enableSSO) {
      const primaryContainer = meta.containers[0];
      const primaryPort = (rawManifest as { containers?: Array<{ primary?: boolean; port?: number }> })
        .containers?.find((c) => c.primary)?.port || 0;
      if (primaryPort > 0) {
        for (let i = 0; i < 15; i++) {
          await new Promise((r) => setTimeout(r, 2000));
          try {
            const ip = await getContainerIP(primaryContainer);
            if (!ip) continue;
            const res = await fetch(`http://${ip}:${primaryPort}/`, {
              signal: AbortSignal.timeout(3000),
            });
            if (res.ok) break;
          } catch { /* not ready yet */ }
        }
      }
    }
  } else {
    // No manifest available — just do string replacement on env vars
    for (const containerName of meta.containers) {
      try {
        const resp = await incusRequest<Record<string, unknown>>(
          'GET',
          `/1.0/instances/${containerName}`
        );
        const meta = resp.metadata as { config?: Record<string, string> } | undefined;
        const config = meta?.config || {};
        const updates: Record<string, string> = {};

        for (const [key, value] of Object.entries(config)) {
          if (key.startsWith('environment.') && typeof value === 'string' && value.includes(oldDomain)) {
            updates[key] = value.replace(new RegExp(escapeRegex(oldDomain), 'g'), newDomain);
          }
        }

        if (Object.keys(updates).length > 0) {
          await incusRequest('PATCH', `/1.0/instances/${containerName}`, { config: updates });
        }
      } catch {
        // Container may not exist
      }
    }

    // Restart containers
    for (const containerName of meta.containers) {
      try {
        await incusRequest('PUT', `/1.0/instances/${containerName}/state`, {
          action: 'restart', force: true, timeout: 30,
        });
      } catch { /* ignore */ }
    }
  }

  // Update Authentik SSO if the app has it
  if (meta.enableSSO && meta.ssoSlug) {
    try {
      await updateAuthentikProvider(akConfig, meta.ssoSlug, oldDomain, newDomain);
    } catch (err) {
      console.error(`[Reconfigure] Failed to update Authentik for ${appId}:`, err);
    }

    // Re-run SSO configure steps for apps that have internal SSO config (like Memos)
    if (rawManifest) {
      const ssoConfig = (rawManifest as { sso?: { configure?: { steps?: Array<Record<string, unknown>> } } }).sso;
      if (ssoConfig?.configure?.steps) {
        try {
          const primaryContainer = meta.containers[0];
          const primaryIP = await getContainerIP(primaryContainer);
          const primaryPort = (rawManifest as { containers?: Array<{ primary?: boolean; port?: number }> })
            .containers?.find((c) => c.primary)?.port || 0;

          const authentikExternalUrl = await getAuthentikExternalUrl(akConfig, newDomain);
          const authentikIP = await getContainerIP('youeye-authentik');

          // Get SSO credentials from the existing provider
          const providers = await authentikAPI<{
            results: Array<{ pk: number; client_id: string; client_secret: string }>;
          }>(akConfig, `/providers/oauth2/?client_id=${encodeURIComponent(meta.ssoSlug)}`);
          const provider = providers.results?.find((p) => p.client_id === meta.ssoSlug);

          if (provider && primaryIP) {
            const ctx = {
              app: { id: appId },
              install: { url: newUrl, subdomain: meta.subdomain, domain: newDomain },
              secrets: {},
              container: { ip: primaryIP, port: primaryPort },
              sso: { clientId: provider.client_id, clientSecret: provider.client_secret },
              authentik: {
                externalUrl: authentikExternalUrl,
                internalUrl: authentikIP ? `http://${authentikIP}:9000` : authentikExternalUrl,
                name: '',
              },
            };

            // Read secrets for SSO step resolution
            const secretSpecs = (rawManifest as { secrets?: Array<{ name: string; file: string }> }).secrets || [];
            for (const sec of secretSpecs) {
              try {
                const { readFile } = await import('fs/promises');
                const val = await readFile(`/var/lib/youeye/app-${appId}/${sec.file}`, 'utf-8');
                (ctx.secrets as Record<string, string>)[sec.name] = val.trim();
              } catch { /* ignore */ }
            }

            const { executeSSOSteps } = await import('@/lib/market/sso-engine');
            await executeSSOSteps(ssoConfig as Parameters<typeof executeSSOSteps>[0], ctx);
          }
        } catch (err) {
          console.error(`[Reconfigure] Failed to re-run SSO steps for ${appId}:`, err);
        }
      }
    }
  }

  // Update metadata
  meta.domain = newDomain;
  await saveInstallMetadata(meta);
}

async function getAuthentikExternalUrl(
  akConfig: AuthentikConfig,
  newDomain: string
): Promise<string> {
  // Try to find from Caddy routes first
  try {
    const { getAuthentikExternalUrl: getFromCaddy } = await import('@/lib/market/authentik');
    const url = await getFromCaddy();
    if (url) return url;
  } catch { /* ignore */ }
  // Fallback: construct from config
  const config = await settingsService.getRaw();
  const authSub = config.subdomains?.auth || 'auth';
  return `https://${authSub}.${newDomain}`;
}

// ─── Main Reconfigure Function ────────────────────────────

/**
 * Reconfigure YouEye's domain, site name, and/or subdomains.
 * This is the main orchestration function.
 */
export async function reconfigure(
  req: ReconfigureRequest,
  onEvent: ReconfigureEventCallback
): Promise<{ newUrl: string }> {
  // 1. Read current config
  onEvent({ step: 'config', status: 'running', message: 'Reading current configuration...' });
  const currentConfig = await settingsService.getRaw();
  const oldDomain = currentConfig.domain;
  const oldSubdomains = currentConfig.subdomains || {} as Record<string, string>;
  const newDomain = req.domain || oldDomain;
  const newSubdomains = req.subdomains || oldSubdomains || {} as Record<string, string>;
  const newSiteName = req.site_name || currentConfig.site_name;
  const domainChanged = newDomain !== oldDomain;
  const subdomainsChanged = JSON.stringify(newSubdomains) !== JSON.stringify(oldSubdomains);
  onEvent({ step: 'config', status: 'done', message: 'Configuration loaded' });

  // 2. Enumerate installed apps
  onEvent({ step: 'apps', status: 'running', message: 'Enumerating installed apps...' });
  const installedApps = await listInstalledApps();
  onEvent({ step: 'apps', status: 'done', message: `Found ${installedApps.length} installed app(s)` });

  // Get Authentik config (needed for SSO updates)
  const akConfig = await getAuthentikConfig();
  const hostIP = process.env.HOST_IP;

  // 3. Update youeye.yaml
  onEvent({ step: 'yaml', status: 'running', message: 'Updating site configuration...' });
  // Use patchConfig (PATCH) instead of setConfig (PUT) to preserve
  // fields not being set here — especially release_branch, which would
  // be silently wiped by a full PUT replace.
  const patchData: Record<string, unknown> = {
    site_name: newSiteName,
    domain: newDomain,
    subdomains: newSubdomains,
    setup_completed: true,
  };
  if (req.authentik_name) {
    patchData.authentik_name = req.authentik_name;
  }
  await settingsService.setRaw(patchData);
  onEvent({ step: 'yaml', status: 'done', message: 'Site configuration updated' });

  // 4. Update Caddy (routes + TLS) — only if domain or subdomains changed
  if (domainChanged || subdomainsChanged) {
    onEvent({ step: 'caddy', status: 'running', message: 'Updating reverse proxy routes...' });
    await updateCaddyDomain(oldDomain, newDomain, oldSubdomains, newSubdomains);
    // Also ensure TLS subjects are correct
    await caddy.setDomain(newDomain);
    onEvent({ step: 'caddy', status: 'done', message: 'Reverse proxy updated' });

    // 5. Update Pi-Hole DNS
    onEvent({ step: 'dns', status: 'running', message: 'Updating DNS configuration...' });
    if (hostIP) {
      try {
        await setDomainDNS(newDomain, hostIP, oldDomain);
        onEvent({ step: 'dns', status: 'done', message: `DNS updated: *.${newDomain} → ${hostIP}` });
      } catch (err) {
        console.error('[Reconfigure] DNS update failed:', err);
        onEvent({ step: 'dns', status: 'done', message: 'DNS update failed (non-critical)' });
      }
    } else {
      onEvent({ step: 'dns', status: 'done', message: 'Skipped — HOST_IP not available' });
    }
  }

  // 6. Update Authentik CP OAuth2
  if (domainChanged || subdomainsChanged) {
    onEvent({ step: 'sso_cp', status: 'running', message: 'Updating Control Panel SSO...' });
    try {
      // Build hostname map for subdomain changes (e.g., control.old → controlpanel.new)
      const cpHostMap = new Map<string, string>();
      const oldControlSub = oldSubdomains.control || 'control';
      const newControlSub = newSubdomains.control || 'control';
      cpHostMap.set(`${oldControlSub}.${oldDomain}`, `${newControlSub}.${newDomain}`);
      await updateAuthentikProvider(akConfig, 'youeye-control', oldDomain, newDomain, cpHostMap);
      onEvent({ step: 'sso_cp', status: 'done', message: 'Control Panel SSO updated' });
    } catch (err) {
      console.error('[Reconfigure] CP SSO update failed:', err);
      onEvent({ step: 'sso_cp', status: 'error', message: `CP SSO update failed: ${err}` });
    }
  }

  // 7. Update Authentik UI OAuth2 + UI env vars
  if (domainChanged || subdomainsChanged) {
    onEvent({ step: 'sso_ui', status: 'running', message: 'Updating UI SSO...' });
    try {
      await updateAuthentikProvider(akConfig, 'youeye-ui', oldDomain, newDomain);

      // Update UI env vars via Spine
      const uiSub = newSubdomains.ui || '';
      const uiHost = uiSub ? `${uiSub}.${newDomain}` : newDomain;
      const authSub = newSubdomains.auth || 'auth';

      // Get existing UI SSO config to preserve secrets
      const uiSSOStatus = await spineClient.getUISSO();
      if (uiSSOStatus.configured) {
        const pgCreds = await spineClient.getPostgresCredentials();
        const dbUrl = `postgresql://${pgCreds.user}:${encodeURIComponent(pgCreds.password)}@${pgCreds.host}:${pgCreds.port}/youeye_ui`;

        // We need to read the existing secrets from env file
        const existingSecrets = await getExistingUISecrets();

        await spineClient.setUISSO({
          authentik_url: `https://${authSub}.${newDomain}`,
          authentik_internal_url: akConfig.url,
          client_id: existingSecrets.clientId || 'youeye-ui',
          client_secret: existingSecrets.clientSecret || '',
          jwt_secret: existingSecrets.jwtSecret || '',
          database_url: dbUrl,
          domain: uiHost,
          base_url: `https://${uiHost}`,
        });
      }
      onEvent({ step: 'sso_ui', status: 'done', message: 'UI SSO updated' });
    } catch (err) {
      console.error('[Reconfigure] UI SSO update failed:', err);
      onEvent({ step: 'sso_ui', status: 'error', message: `UI SSO update failed: ${err}` });
    }
  }

  // 9. Update site_name in UI database
  if (req.site_name || req.site_name_style) {
    onEvent({ step: 'ui_db', status: 'running', message: 'Updating UI branding...' });
    try {
      const { execShell } = await import('@/lib/incus/server');

      if (req.site_name) {
        const siteName = req.site_name.replace(/"/g, '\\"');
        const sqlCmd = `INSERT INTO system_settings (key, value, updated_at) VALUES ('site_name', '"${siteName}"'::jsonb, NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();`;
        const b64 = Buffer.from(sqlCmd).toString('base64');
        await execShell(
          'youeye-postgres',
          `echo "${b64}" | base64 -d | su - postgres -c "psql -U youeye -d youeye_ui"`,
          { timeout: 10000 }
        );
      }

      if (req.site_name_style) {
        const styleJson = JSON.stringify(req.site_name_style).replace(/'/g, "''");
        const styleSql = `INSERT INTO system_settings (key, value, updated_at) VALUES ('site_name_style', '${styleJson}'::jsonb, NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();`;
        const styleB64 = Buffer.from(styleSql).toString('base64');
        await execShell(
          'youeye-postgres',
          `echo "${styleB64}" | base64 -d | su - postgres -c "psql -U youeye -d youeye_ui"`,
          { timeout: 10000 }
        );
      }

      onEvent({ step: 'ui_db', status: 'done', message: 'UI branding updated' });
    } catch (err) {
      console.error('[Reconfigure] UI DB update failed:', err);
      onEvent({ step: 'ui_db', status: 'done', message: 'UI branding update failed (non-critical)' });
    }
  }

  // 10. Refresh infrastructure containers (ensures DNS/DHCP leases are valid before restarting apps)
  if (domainChanged && installedApps.length > 0) {
    try {
      await incusRequest('PUT', '/1.0/instances/youeye-postgres/state', {
        action: 'restart', force: false, timeout: 30,
      });
      // Wait for postgres to be ready
      await new Promise((resolve) => setTimeout(resolve, 5000));
    } catch {
      // Postgres restart failed — apps may still work if DNS is valid
    }
  }

  // 11. Update installed market apps
  if (domainChanged && installedApps.length > 0) {
    for (const app of installedApps) {
      onEvent({ step: `app_${app.appId}`, status: 'running', message: `Updating ${app.appId}...` });
      try {
        await updateInstalledApp(app, oldDomain, newDomain, akConfig);
        onEvent({ step: `app_${app.appId}`, status: 'done', message: `${app.appId} updated` });
      } catch (err) {
        console.error(`[Reconfigure] Failed to update app ${app.appId}:`, err);
        onEvent({ step: `app_${app.appId}`, status: 'error', message: `${app.appId} failed: ${err}` });
      }
    }
  }

  // 11b. Propagate system language to installed marketplace apps
  // This ensures that apps with language.env_var in their manifest get the current system language
  if (installedApps.length > 0) {
    try {
      const config = await settingsService.getRaw();
      const systemLang = config.language || 'en';
      for (const app of installedApps) {
        await propagateLanguageToApp(app, systemLang);
      }
    } catch {
      // Language propagation is best-effort — don't fail reconfigure
    }
  }

  // 12. Update CP SSO env vars — LAST STEP because setControlSSO triggers a 2s delayed restart.
  // Everything else must be done before this point.
  if (domainChanged || subdomainsChanged) {
    onEvent({ step: 'cp_env', status: 'running', message: 'Updating Control Panel environment (will restart)...' });
    const controlSub = newSubdomains.control || 'control';
    const authSub = newSubdomains.auth || 'auth';
    await spineClient.setControlSSO({
      authentik_url: `https://${authSub}.${newDomain}`,
      client_id: 'youeye-control',
      client_secret: await getCurrentCPSecret(),
      internal_url: akConfig.url,
      control_url: `https://${controlSub}.${newDomain}`,
    });
    onEvent({ step: 'cp_env', status: 'done', message: 'Control Panel environment updated — restarting in 2s' });
  }

  // 13. Build result URL
  const controlSub = newSubdomains.control || 'control';
  const newUrl = `https://${controlSub}.${newDomain}`;

  onEvent({ step: 'complete', status: 'done', message: 'Reconfiguration complete' });

  return { newUrl };
}

// ─── Helper: Get current CP SSO client secret ─────────────

async function getCurrentCPSecret(): Promise<string> {
  // Read from current environment
  return process.env.AUTHENTIK_CLIENT_SECRET || '';
}

// ─── Helper: Get existing UI SSO secrets ──────────────────

async function getExistingUISecrets(): Promise<{
  clientId: string;
  clientSecret: string;
  jwtSecret: string;
}> {
  try {
    const { readFile } = await import('fs/promises');
    const content = await readFile('/var/lib/youeye/ui/.env', 'utf-8');
    const vars: Record<string, string> = {};
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 0) {
        vars[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1);
      }
    }
    return {
      clientId: vars.AUTHENTIK_CLIENT_ID || 'youeye-ui',
      clientSecret: vars.AUTHENTIK_CLIENT_SECRET || '',
      jwtSecret: vars.JWT_SECRET || '',
    };
  } catch {
    return { clientId: 'youeye-ui', clientSecret: '', jwtSecret: '' };
  }
}

// ─── Helper: Propagate language env var to a marketplace app ──

/**
 * Read the app's manifest from the catalog, check if it has a language config,
 * and if so, update the container's environment variable via incus config set.
 */
async function propagateLanguageToApp(
  app: InstallMetadata,
  systemLang: string
): Promise<void> {
  try {
    // Import the catalog fetcher to get the manifest
    const { fetchManifest } = await import('@/lib/market/catalog');
    const manifest = await fetchManifest(app.appId);
    if (!manifest?.language) return;

    const langValue = manifest.language.format === 'full'
      ? ({ en: 'english', ru: 'russian', es: 'spanish', de: 'german', fr: 'french' }[systemLang] || 'english')
      : systemLang;

    // Set the environment variable on each container
    for (const containerSpec of manifest.containers) {
      const containerName = manifest.containers.length === 1
        ? `app-${app.appId}`
        : `app-${app.appId}-${containerSpec.name}`;
      await incusRequest('PATCH', `/1.0/instances/${containerName}`, {
        config: {
          [`environment.${manifest.language.env_var}`]: langValue,
        },
      });
    }
  } catch {
    // Best-effort — app may not be running or manifest may not be available
  }
}
