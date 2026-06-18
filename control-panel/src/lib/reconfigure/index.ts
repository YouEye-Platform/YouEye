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
import { resolveVariables } from '@/lib/market/variables';
import { writeAllConfigFiles } from '@/lib/market/config-writer';
import { incusRequest } from '@/lib/incus/server';
import type { InstallMetadata } from '@/lib/market/types';
import {
  configureControlPanelIdentitySSO,
  configureUIIdentitySSO,
} from '@/lib/identity/core-clients';
import { getClient } from '@/lib/identity/store';
import { createOAuthClient } from '@/lib/identity/provider';

export interface ReconfigureRequest {
  site_name?: string;
  domain?: string;
  subdomains?: Record<string, string>;
  site_name_style?: Record<string, unknown>;
  identity_name?: string;
}

export interface ReconfigureEvent {
  step: string;
  status: 'running' | 'done' | 'error';
  message?: string;
}

export type ReconfigureEventCallback = (event: ReconfigureEvent) => void;

// NOTE: YouEye uses a HOMEGROUND OIDC provider (control-panel/src/lib/identity/*),
// NOT Authentik — there is no youeye-authentik container. The old Authentik helpers
// (getAuthentikConfig/authentikAPI/updateAuthentikProvider/getAuthentikExternalUrl)
// were dead code that threw on every domain change; removed. App SSO re-sync now goes
// through the homegrown `identity_clients` store + integration re-apply (see updateInstalledApp).

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

// ─── Homegrown identity_clients re-sync ───────────────────

/**
 * Re-sync an installed app's homegrown OAuth client (`identity_clients`) to a new
 * domain by domain-replacing its stored `redirect_uris`, PRESERVING the client_secret.
 * (After Phase 1 the back-channel is internal/domain-free; only redirect_uris carry the
 * domain.) Non-domain callbacks like `app://oauth` pass through unchanged. No-op if the
 * client doesn't exist. Used for env-OIDC apps; integration apps are additionally re-applied.
 */
async function resyncClientRedirectUris(
  clientId: string,
  oldDomain: string,
  newDomain: string,
): Promise<void> {
  const existing = await getClient(clientId);
  if (!existing) return;
  const oldRe = new RegExp(escapeRegex(oldDomain), 'g');
  const newRedirectUris = (existing.redirect_uris || []).map((uri) => uri.replace(oldRe, newDomain));
  await createOAuthClient({
    clientId: existing.client_id,
    name: existing.name,
    redirectUris: newRedirectUris,
    scopes: existing.scopes,
    clientSecret: existing.client_secret, // preserve — no secret rotation on a domain change
  });
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── App Domain Update ────────────────────────────────────

/**
 * Fetch an app manifest from the configured Market source (Forgejo, the active release
 * branch) via the catalog. The previous implementation hit a dead GitHub URL
 * (`raw.githubusercontent.com/YouEye-Platform/Market/main/apps/...`) and always returned
 * null, so every reconfigure fell back to naive env string-replacement.
 */
async function fetchAppManifest(appId: string): Promise<Record<string, unknown> | null> {
  try {
    const { fetchManifest } = await import('@/lib/market/catalog');
    return (await fetchManifest(appId)) as unknown as Record<string, unknown> | null;
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
): Promise<void> {
  const appId = meta.appId;
  const newUrl = `https://${meta.subdomain}.${newDomain}`;
  // `meta.containers` holds ContainerMeta objects ({ containerName, ... }); some legacy
  // metadata stored plain strings. Resolve the real incus instance names either way —
  // the original restart loops iterated the objects directly, producing "[object Object]"
  // (so they silently never restarted anything on a domain change).
  const containerNames = (meta.containers as Array<string | { containerName?: string }>)
    .map((c) => (typeof c === 'string' ? c : c?.containerName))
    .filter((n): n is string => !!n);

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

    const ctx: Record<string, unknown> = {
      app: { id: appId, name: '', subdomain: meta.subdomain, fqdn: `${meta.subdomain}.${newDomain}`, url: newUrl, internal_url: '' },
      install: {
        url: newUrl,
        subdomain: meta.subdomain,
        domain: newDomain,
      },
      secrets,
      container: { ip: '', port: 0 },
      sso: { clientId: meta.ssoClientId || '', clientSecret: '' },
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
    for (const containerName of containerNames) {
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
      const primaryContainer = containerNames[0];
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
    for (const containerName of containerNames) {
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
    for (const containerName of containerNames) {
      try {
        await incusRequest('PUT', `/1.0/instances/${containerName}/state`, {
          action: 'restart', force: true, timeout: 30,
        });
      } catch { /* ignore */ }
    }
  }

  // Persist the new domain to install metadata BEFORE the SSO re-sync. applyIntegration
  // reloads metadata from disk (readInstallMetadata) and computes redirect_uris/authorize
  // URLs from targetMeta.domain — so it MUST see the new domain here. Previously this save
  // happened at the very end, so integration apps (e.g. Audiobookshelf) re-applied against
  // the STALE old domain and silently overwrote the correct resync (env-OIDC apps were
  // unaffected because resyncClientRedirectUris domain-replaces the stored URIs directly).
  meta.domain = newDomain;
  await saveInstallMetadata(meta);

  // Re-sync the homegrown OIDC client(s) to the new domain (NOT Authentik — removed;
  // there is no youeye-authentik container).
  if (meta.enableSSO) {
    // (a) Base app client: domain-replace its redirect_uris, PRESERVING the secret.
    //     Covers env-OIDC apps (Vaultwarden, Mealie, ...). After Phase 1 the back-channel
    //     (issuer/discovery/token/userinfo/jwks) is internal & domain-free, so only the
    //     redirect_uris carry the domain.
    const baseClientId = meta.ssoClientId || meta.ssoSlug;
    if (baseClientId) {
      try {
        await resyncClientRedirectUris(baseClientId, oldDomain, newDomain);
      } catch (err) {
        console.error(`[Reconfigure] Failed to re-sync redirect_uris for ${appId}:`, err);
      }
    }
    // (b) Integration apps: re-apply each installed identity integration with the NEW
    //     domain context. applyIntegration re-creates the OAuth client (redirect_uris
    //     recomputed from the new domain) and re-runs the app's SSO setup steps, which
    //     rewrite the app's stored EXTERNAL authorize URL to the new domain.
    //     applyIntegration reloads install metadata from disk (readInstallMetadata) and
    //     derives appUrl from targetMeta.domain — which we persisted to newDomain just
    //     above, so the recomputed redirect_uris/authorize URL track the new domain. The
    //     app is still running here (we restart after), so its setup-step API calls succeed.
    if (meta.installedIntegrations?.length) {
      const { applyIntegration } = await import('@/lib/market/integration-runner');
      for (const integ of meta.installedIntegrations) {
        try {
          await applyIntegration({ integrationId: integ.id, sourceId: integ.sourceId }, () => {});
        } catch (err) {
          console.error(`[Reconfigure] Failed to re-apply integration ${integ.id} for ${appId}:`, err);
        }
      }
      // Restart so any cached OIDC client (e.g. Audiobookshelf builds its openid-client
      // once and caches it) rebuilds from the freshly re-applied config.
      for (const containerName of containerNames) {
        try {
          await incusRequest('PUT', `/1.0/instances/${containerName}/state`, { action: 'restart', force: true, timeout: 30 });
        } catch { /* container may not be running */ }
      }
    }
  }
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
  if (req.identity_name) {
    patchData.identity = {
      ...(typeof currentConfig.identity === 'object' && currentConfig.identity ? currentConfig.identity : {}),
      provider: 'youeye-id',
      name: req.identity_name,
    };
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

  // 6. Defer Control Panel OAuth update until the final env/restart step.
  if (domainChanged || subdomainsChanged) {
    onEvent({ step: 'sso_cp', status: 'running', message: 'Updating Control Panel SSO...' });
    onEvent({ step: 'sso_cp', status: 'done', message: 'Control Panel SSO update deferred until restart step' });
  }

  // 7. Update YouEye ID UI OAuth2 + UI env vars
  if (domainChanged || subdomainsChanged) {
    onEvent({ step: 'sso_ui', status: 'running', message: 'Updating UI SSO...' });
    try {
      const uiSub = newSubdomains.ui || '';
      const uiHost = uiSub ? `${uiSub}.${newDomain}` : newDomain;

      // Get existing UI SSO config to preserve secrets
      const uiSSOStatus = await spineClient.getUISSO();
      if (uiSSOStatus.configured) {
        const pgCreds = await spineClient.getPostgresCredentials();
        const dbUrl = `postgresql://${pgCreds.user}:${encodeURIComponent(pgCreds.password)}@${pgCreds.host}:${pgCreds.port}/youeye_ui`;

        // We need to read the existing secrets from env file
        const existingSecrets = await getExistingUISecrets();

        await configureUIIdentitySSO({
          uiExternalUrl: `https://${uiHost}`,
          databaseUrl: dbUrl,
          jwtSecret: existingSecrets.jwtSecret || undefined,
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
        await updateInstalledApp(app, oldDomain, newDomain);
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

  // 11c. Propagate platform env vars (site name, timezone, locale) to all installed apps
  // This ensures YOUEYE_SITE_NAME etc. are always current after reconfigure.
  if (installedApps.length > 0) {
    try {
      const { propagateSettingsToApps } = await import('@/lib/market/propagation');
      await propagateSettingsToApps();
    } catch {
      // Platform env propagation is best-effort
    }
  }

  // 11d. Emit settings.changed event
  try {
    const { emitEvent } = await import('@/lib/events/emitter');
    emitEvent('settings.changed', {
      siteName: newSiteName,
      domain: newDomain,
      domainChanged,
      subdomainsChanged,
    });
  } catch { /* best-effort */ }

  // 12. Update CP SSO env vars — LAST STEP because setControlSSO triggers a 2s delayed restart.
  // Everything else must be done before this point.
  if (domainChanged || subdomainsChanged) {
    onEvent({ step: 'cp_env', status: 'running', message: 'Updating Control Panel environment (will restart)...' });
    const controlSub = newSubdomains.control || 'control';
    await configureControlPanelIdentitySSO({
      controlExternalUrl: `https://${controlSub}.${newDomain}`,
      settingsExternalUrl: `https://${newDomain}/settings`,
    });
    onEvent({ step: 'cp_env', status: 'done', message: 'Control Panel environment updated — restarting in 2s' });
  }

  // 13. Build result URL
  const controlSub = newSubdomains.control || 'control';
  const newUrl = `https://${controlSub}.${newDomain}`;

  onEvent({ step: 'complete', status: 'done', message: 'Reconfiguration complete' });

  return { newUrl };
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
      clientId: vars.IDENTITY_CLIENT_ID || 'youeye-ui',
      clientSecret: vars.IDENTITY_CLIENT_SECRET || '',
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
    // Language is now handled via env_mapping with ${platform.locale}
    const { fetchManifest } = await import('@/lib/market/catalog');
    const manifest = await fetchManifest(app.appId);
    const envMapping = manifest?.env_mapping ?? {};
    const localeEntry = Object.entries(envMapping).find(([, v]) => v.includes('${platform.locale'));
    if (!localeEntry) return;

    const [envVar] = localeEntry;
    for (const containerSpec of manifest.containers) {
      const containerName = manifest.containers.length === 1
        ? `app-${app.appId}`
        : `app-${app.appId}-${containerSpec.name}`;
      await incusRequest('PATCH', `/1.0/instances/${containerName}`, {
        config: { [`environment.${envVar}`]: systemLang },
      });
    }
  } catch {
    // Best-effort — app may not be running or manifest may not be available
  }
}
