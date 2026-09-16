/**
 * Server Reconfiguration Engine
 *
 * Handles changing YouEye's domain (server URL), site name, and subdomains after
 * initial setup. Orchestrates updates across all systems: youeye.yaml, Caddy,
 * Pi-Hole, TLS certificates, YouEye ID, Control Panel SSO, UI SSO, and every
 * installed app (native and market, LXD and OCI).
 *
 * Key design decisions:
 * - The CP orchestrates everything except its own restart. After all changes are
 *   applied, it schedules a delayed restart via Spine (setControlSSO), so the SSE
 *   stream completes before the process dies.
 * - App propagation uses exact string replacement of the old domain in existing
 *   env files / container env config / rendered config files. A URL change keeps
 *   every subdomain and secret identical, so replacement is semantically exact,
 *   never rotates credentials, and works even when the Market catalog is
 *   unreachable. Manifest templates are only rendered for config files that do
 *   not exist yet (e.g. a manifest gained a configFile after the app was
 *   installed).
 * - TLS follows an explicit target: selfsigned (internal CA re-issues for the new
 *   name), provider (existing BYO DNS provider re-issues via ACME DNS-01), or a
 *   names/BYO bundle applied by the post-setup import endpoints.
 */

import { settingsService } from '@/lib/settings';
import { spineClient } from '@/lib/spine/client';
import * as caddy from '@/lib/caddy/client';
import { setDomainDNS } from '@/lib/apps/pihole-api';
import { listInstalledApps, saveInstallMetadata } from '@/lib/market/metadata';
import { getContainerIP } from '@/lib/incus/container-ip';
import { resolveVariables } from '@/lib/market/variables';
import {
  enforceConfigFilePermissions,
  readConfigFile,
  writeConfigFileToStorage,
} from '@/lib/market/config-writer';
import { incusRequest, execShell } from '@/lib/incus/server';
import { getContainerName } from '@/lib/market/engine-helpers';
import { restartContainerAndWait } from '@/lib/infrastructure/oci-deployer';
import { CONTAINER_DOMAIN } from '@/lib/market/constants';
import type { InstallMetadata, AppManifest, ConfigFileSpec } from '@/lib/market/types';
import {
  configureControlPanelIdentitySSO,
  configureUIIdentitySSO,
} from '@/lib/identity/core-clients';
import { getClient } from '@/lib/identity/store';
import { createOAuthClient } from '@/lib/identity/provider';
import { issueCertificateWithDnsProvider } from '@/lib/acme/client';
import { CloudflareDnsProvider } from '@/lib/dns-providers/cloudflare';
import {
  getByoDnsProviderConfig,
  saveByoDnsProviderConfig,
  clearByoDnsProviderConfig,
  createConnectionId,
} from '@/lib/dns-providers/config';
import { managedAddressNames, isPrivateIPv4 } from '@/lib/dns-providers/domain';
import { readProviderToken, writeProviderToken, deleteProviderToken } from '@/lib/dns-providers/secrets';
import { syncByoDomainDns } from '@/lib/dns-providers/sync';
import { validateDnsProvider } from '@/lib/dns-providers/validation';
import { tlsStorage } from '@/lib/acme/storage';
import { bundleCertStillValid, type NamesBundle } from '@/lib/youeye-names/bundle';
import type { ByoDomainBundle } from '@/lib/byo-domain/bundle';
import { bundleToProviderConfig, byoDomainBundleCertStillValid } from '@/lib/byo-domain/bundle';
import {
  claimName,
  getCertificateTerms,
  getCurrentCertificate,
  getLease,
  NamesBrokerError,
  requestCertificate,
  updateIp,
} from '@/lib/youeye-names/client';
import type { InstallIdentity } from '@/lib/youeye-names/identity';
import { generateCsr } from '@/lib/youeye-names/csr';
import {
  sameCertificateInstant,
  validateCertificateMaterial,
} from '@/lib/youeye-names/certificate';
import { configurePointerForPlatform } from '@/lib/infrastructure/deployer';

/**
 * TLS target for the new domain.
 * - 'auto'        — provider re-issue when a BYO DNS provider manages the platform
 *                   domain, otherwise self-signed (internal CA).
 * - 'selfsigned'  — internal CA; any external cert is removed so Caddy mints a
 *                   fresh certificate for the new name.
 * - 'provider'    — re-validate the configured DNS provider for the new domain,
 *                   sync records, and issue a fresh ACME certificate.
 * - 'names-bundle' — apply an imported YouEye Names bundle (programmatic only;
 *                   set by POST /api/tls/youeye-names/apply).
 * - 'byo-bundle'  — apply an imported BYO domain bundle (programmatic only;
 *                   set by POST /api/tls/domain/apply).
 */
export type ReconfigureTlsTarget = 'auto' | 'selfsigned' | 'provider' | 'names-bundle' | 'byo-bundle';

export interface ReconfigureRequest {
  site_name?: string;
  domain?: string;
  subdomains?: Record<string, string>;
  site_name_style?: Record<string, unknown>;
  identity_name?: string;
  tls?: ReconfigureTlsTarget;
  /** Programmatic only — provided by the names apply endpoint, never over the wire. */
  namesBundle?: NamesBundle;
  /** Validated imported identity used before the persistent authority is committed. */
  namesIdentity?: InstallIdentity;
  /** Programmatic only — provided by the domain apply endpoint, never over the wire. */
  byoBundle?: ByoDomainBundle;
}

export interface ReconfigureEvent {
  step: string;
  status: 'running' | 'done' | 'error';
  message?: string;
}

export type ReconfigureEventCallback = (event: ReconfigureEvent) => void;

// NOTE: YouEye uses a HOMEGROWN OIDC provider (control-panel/src/lib/identity/*).
// App SSO re-sync goes through the `identity_clients` store + integration re-apply
// (see updateInstalledApp).

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
        if (m.host) {
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
        // Header matchers carry the domain too — the root-domain CP-surface
        // route (control-settings-support-route) matches on
        // `Referer: *://<domain>/settings*`. Missing this left CP assets
        // falling through to the UI (404, unstyled /settings) after a rename.
        const headerMatch = (m as { header?: Record<string, unknown> }).header;
        if (headerMatch) {
          for (const [name, values] of Object.entries(headerMatch)) {
            if (Array.isArray(values)) {
              headerMatch[name] = values.map((v) =>
                typeof v === 'string' ? replaceAll(v, oldDomain, newDomain) : v,
              );
            }
          }
        }
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
  if (config.apps?.tls?.certificates?.automate) {
    config.apps.tls.certificates.automate = config.apps.tls.certificates.automate.map((subject) => {
      if (subject === `*.${oldDomain}`) return `*.${newDomain}`;
      if (subject === oldDomain) return newDomain;
      if (subject.endsWith(`.${oldDomain}`)) {
        const sub = subject.slice(0, -(oldDomain.length + 1));
        return `${sub}.${newDomain}`;
      }
      return subject;
    });
  }

  await caddy.setConfig(config);
}

// ─── Homegrown identity_clients re-sync ───────────────────

/**
 * Re-sync an installed app's homegrown OAuth client (`identity_clients`) to a new
 * domain by domain-replacing its stored `redirect_uris`, PRESERVING the client_secret.
 * (The back-channel is internal/domain-free; only redirect_uris carry the domain.)
 * Non-domain callbacks like `app://oauth` pass through unchanged. No-op if the
 * client doesn't exist. Used for env-OIDC apps; integration apps are additionally re-applied.
 */
async function resyncClientRedirectUris(
  clientId: string,
  oldDomain: string,
  newDomain: string,
): Promise<void> {
  const existing = await getClient(clientId);
  if (!existing) return;
  const newRedirectUris = (existing.redirect_uris || []).map((uri) => replaceAll(uri, oldDomain, newDomain));
  await createOAuthClient({
    clientId: existing.client_id,
    name: existing.name,
    redirectUris: newRedirectUris,
    scopes: existing.scopes,
    clientSecret: existing.client_secret, // preserve — no secret rotation on a domain change
  });
}

/** Exact, global, regex-free string replacement. */
function replaceAll(value: string, from: string, to: string): string {
  return value.split(from).join(to);
}

// ─── App Domain Update ────────────────────────────────────

/**
 * Fetch an app manifest from the app's own Market source (falls back to the
 * default source). Best-effort: returns null when the catalog is unreachable —
 * env propagation does not depend on it.
 */
async function fetchAppManifest(appId: string, sourceId?: string): Promise<AppManifest | null> {
  try {
    const { fetchManifestFromSource } = await import('@/lib/market/catalog');
    return await fetchManifestFromSource(appId, sourceId);
  } catch {
    try {
      const { fetchManifest } = await import('@/lib/market/catalog');
      return await fetchManifest(appId);
    } catch {
      return null;
    }
  }
}

/** Resolve container entries from install metadata (tolerates legacy string entries). */
function containerEntries(meta: InstallMetadata): Array<{ containerName: string; type?: string }> {
  return (meta.containers as Array<string | { containerName?: string; type?: string }>)
    .map((c) => (typeof c === 'string' ? { containerName: c } : { containerName: c?.containerName || '', type: c?.type }))
    .filter((c) => !!c.containerName);
}

/**
 * Replace the old domain in a container's env file (/etc/<container>.env).
 * This is how the install engine provisions LXD (native) app env — IDENTITY_URL,
 * APP_URL, <APP>_EXTERNAL_URL etc. all live here. Returns true when changed.
 */
async function updateContainerEnvFile(
  containerName: string,
  oldDomain: string,
  newDomain: string,
): Promise<boolean> {
  const envPath = `/etc/${containerName}.env`;
  let content = '';
  try {
    const read = await execShell(containerName, `cat ${envPath}`, { timeout: 10_000 });
    if (read.exitCode !== 0) return false;
    content = read.stdout;
  } catch {
    return false; // no env file — nothing to do
  }
  if (!content.includes(oldDomain)) return false;
  const next = replaceAll(content, oldDomain, newDomain);
  const b64 = Buffer.from(next).toString('base64');
  const write = await execShell(containerName, `echo '${b64}' | base64 -d > ${envPath}`, { timeout: 10_000 });
  if (write.exitCode !== 0) {
    throw new Error(`Failed to write ${envPath} in ${containerName}: ${write.stderr}`);
  }
  return true;
}

/**
 * Replace the old domain in a container's Incus `environment.*` config keys.
 * This is how OCI (market) app env is provisioned. Returns true when changed.
 */
async function updateContainerEnvConfig(
  containerName: string,
  oldDomain: string,
  newDomain: string,
): Promise<boolean> {
  const resp = await incusRequest<Record<string, unknown>>('GET', `/1.0/instances/${containerName}`);
  const instMeta = resp.metadata as { config?: Record<string, string> } | undefined;
  const config = instMeta?.config || {};
  const updates: Record<string, string> = {};

  for (const [key, value] of Object.entries(config)) {
    if (key.startsWith('environment.') && typeof value === 'string' && value.includes(oldDomain)) {
      updates[key] = replaceAll(value, oldDomain, newDomain);
    }
  }

  if (Object.keys(updates).length === 0) return false;
  await incusRequest('PATCH', `/1.0/instances/${containerName}`, { config: updates });
  return true;
}

/**
 * Build a best-effort variable context for rendering config files that don't
 * exist yet (a manifest gained a configFile after this app was installed).
 * Existing rendered files are updated via string replacement instead and never
 * need this context.
 */
async function buildRenderContext(
  manifest: AppManifest,
  meta: InstallMetadata,
  newDomain: string,
): Promise<Record<string, unknown>> {
  const fqdn = `${meta.subdomain}.${newDomain}`;
  const appUrl = `https://${fqdn}`;

  // Secrets from disk (never regenerated here)
  const secrets: Record<string, string> = {};
  const { readFile } = await import('fs/promises');
  for (const sec of manifest.secrets || []) {
    try {
      secrets[sec.name] = (await readFile(`/var/lib/youeye/app-${meta.appId}/${sec.file}`, 'utf-8')).trim();
    } catch {
      // Secret may not exist — leave unresolved; render is wrapped in try/catch
    }
  }

  // Containers map (internal DNS names are domain-free)
  const containers: Record<string, { internal_host: string; internal_url: string; url: string }> = {};
  for (const c of manifest.containers) {
    const cn = getContainerName(meta.appId, c.name, manifest.containers.length);
    const isPrimary = c.primary || manifest.containers.length === 1;
    containers[c.name] = {
      internal_host: `${cn}.${CONTAINER_DOMAIN}`,
      internal_url: c.port ? `http://${cn}.${CONTAINER_DOMAIN}:${c.port}` : `http://${cn}.${CONTAINER_DOMAIN}`,
      url: isPrimary ? appUrl : '',
    };
  }

  // Platform context — read fresh settings (the domain was already persisted)
  let locale = 'en';
  let timezone = 'UTC';
  let siteName = 'YouEye';
  try {
    const raw = await settingsService.getRaw() as Record<string, unknown>;
    locale = (raw.language as string) || 'en';
    timezone = (raw.timezone as string) || 'UTC';
    siteName = (raw.site_name as string) || 'YouEye';
  } catch { /* defaults */ }

  // SSO client (existing credentials, never rotated here)
  let ssoClientSecret = '';
  const ssoClientId = meta.ssoClientId || meta.ssoSlug || '';
  if (ssoClientId) {
    try {
      const client = await getClient(ssoClientId);
      ssoClientSecret = client?.client_secret || '';
    } catch { /* best-effort */ }
  }

  return {
    platform: {
      domain: newDomain,
      locale,
      timezone,
      site_name: siteName,
    },
    app: {
      id: meta.appId,
      name: manifest.metadata?.name || meta.appId,
      subdomain: meta.subdomain,
      fqdn,
      url: appUrl,
      internal_url: '',
    },
    install: {
      url: appUrl,
      subdomain: meta.subdomain,
      domain: newDomain,
    },
    containers,
    secrets,
    sso: {
      slug: meta.ssoSlug || '',
      client_id: ssoClientId,
      client_secret: ssoClientSecret,
    },
    container: { ip: '', port: 0 },
  };
}

/**
 * Refresh manifest-declared config files for the new domain.
 * - Rendered file exists → exact string replacement (secrets untouched).
 * - Rendered file missing → render fresh from the manifest template (covers
 *   manifests that gained a configFile after this app was installed, e.g. the
 *   Nextcloud trusted-domains file).
 */
async function refreshConfigFiles(
  manifest: AppManifest,
  meta: InstallMetadata,
  oldDomain: string,
  newDomain: string,
  warn: (message: string) => void,
): Promise<Array<{ containerName: string; spec: ConfigFileSpec; context: Record<string, unknown> }>> {
  const configFiles: ConfigFileSpec[] = manifest.configFiles || [];
  if (configFiles.length === 0) return [];

  const refreshed: Array<{ containerName: string; spec: ConfigFileSpec; context: Record<string, unknown> }> = [];
  const ctx = await buildRenderContext(manifest, meta, newDomain);
  for (const cf of configFiles) {
    const target = meta.containers.find((container) =>
      typeof container !== 'string' && container.name === cf.container
    );
    if (!target || typeof target === 'string') {
      warn(`${meta.appId}: config file targets unknown container ${cf.container}`);
      continue;
    }
    let resolvedPath: string;
    try {
      resolvedPath = resolveVariables(cf.path, ctx);
    } catch {
      resolvedPath = cf.path.split('${app.id}').join(meta.appId);
    }

    const volumes = target.type === 'oci'
      ? meta.storageVolumes?.filter((volume) => volume.containerName === target.containerName)
      : undefined;
    refreshed.push({ containerName: target.containerName, spec: cf, context: ctx });
    let existing: string | null = null;
    try {
      existing = (await readConfigFile(target.containerName, cf, ctx, volumes)).toString('utf8');
    } catch {
      existing = null;
    }

    if (existing !== null) {
      if (existing.includes(oldDomain)) {
        try {
          await writeConfigFileToStorage(
            target.containerName,
            cf,
            ctx,
            volumes,
            Buffer.from(replaceAll(existing, oldDomain, newDomain), 'utf8'),
          );
        } catch (err) {
          throw new Error(`${meta.appId}: failed to update config file ${resolvedPath}: ${err}`);
        }
      }
    } else {
      try {
        await writeConfigFileToStorage(target.containerName, cf, ctx, volumes);
      } catch (err) {
        warn(`${meta.appId}: failed to render config file ${cf.path}: ${err}`);
      }
    }
  }
  return refreshed;
}

/**
 * Update a single installed app's domain.
 * Updates: env files (LXD), Incus env config (OCI), rendered config files,
 * identity SSO clients, install metadata. Restarts containers (honoring an
 * intentionally-stopped desiredState).
 */
async function updateInstalledApp(
  meta: InstallMetadata,
  oldDomain: string,
  newDomain: string,
  warn: (message: string) => void,
): Promise<void> {
  const appId = meta.appId;
  const containers = containerEntries(meta);
  const containerNames = containers.map((c) => c.containerName);

  // 1. Propagate the new domain into container environments.
  //    Exact string replacement: subdomains and secrets are untouched, and this
  //    works even when the Market catalog is unreachable. Both mechanisms are
  //    attempted for every container — LXD apps use /etc/<name>.env, OCI apps
  //    use Incus environment.* config; the other path is a cheap no-op.
  for (const { containerName } of containers) {
    try {
      await updateContainerEnvFile(containerName, oldDomain, newDomain);
    } catch (err) {
      warn(`${appId}: env file update failed for ${containerName}: ${err}`);
    }
    try {
      await updateContainerEnvConfig(containerName, oldDomain, newDomain);
    } catch (err) {
      warn(`${appId}: env config update failed for ${containerName}: ${err}`);
    }
  }

  // 2. Refresh manifest-declared config files (SearXNG settings.yml,
  //    Nextcloud trusted-domains file, ...).
  const manifest = await fetchAppManifest(appId, meta.sourceId);
  let refreshedConfigFiles: Array<{ containerName: string; spec: ConfigFileSpec; context: Record<string, unknown> }> = [];
  if (manifest) {
    refreshedConfigFiles = await refreshConfigFiles(manifest, meta, oldDomain, newDomain, warn);
  } else {
    warn(`${appId}: manifest unavailable — config file refresh skipped (env updated)`);
  }

  // 3. Restart containers so the new env takes effect — unless the owner
  //    intentionally stopped this app.
  const intentionallyStopped = meta.desiredState === 'stopped' || meta.enabled === false;
  if (!intentionallyStopped) {
    for (const container of containers) {
      await restartContainerAndWait(container.containerName);
    }

    for (const configFile of refreshedConfigFiles) {
      await enforceConfigFilePermissions(configFile.containerName, configFile.spec, configFile.context);
    }

    // Wait for the primary container to be ready before running SSO steps
    if (meta.enableSSO && manifest) {
      const primary = manifest.containers.find((c) => c.primary) || manifest.containers[0];
      const primaryPort = primary?.port || 0;
      const primaryContainerName = getContainerName(appId, primary?.name || 'main', manifest.containers.length);
      if (primaryPort > 0) {
        // Up to 60s — after a whole-platform rename every app restarts at
        // once, so DHCP leases + app boot can take well past 30s.
        for (let i = 0; i < 30; i++) {
          await new Promise((r) => setTimeout(r, 2000));
          try {
            const ip = await getContainerIP(primaryContainerName);
            if (!ip) continue;
            const res = await fetch(`http://${ip}:${primaryPort}/`, {
              signal: AbortSignal.timeout(3000),
            });
            if (res.ok || res.status < 500) break;
          } catch { /* not ready yet */ }
        }
      }
    }

    // Manifest reconfigure hooks — app-specific cleanup a URL change needs
    // beyond env/config/restart. Runs AFTER restart so e.g. a cache flush
    // hits the fresh process (Nextcloud's valkey persists a stale OIDC
    // discovery document across restarts; its manifest flushes it here).
    const hookCommands = manifest
      ? ((manifest as { reconfigure?: { commands?: Array<{ container: string; command: string; timeout?: number }> } })
          .reconfigure?.commands || [])
      : [];
    for (const hook of hookCommands) {
      const target = getContainerName(appId, hook.container, manifest?.containers.length || 1);
      try {
        const result = await execShell(target, hook.command, { timeout: hook.timeout || 30_000 });
        if (result.exitCode !== 0) {
          warn(`${appId}: reconfigure hook on ${target} exited ${result.exitCode}: ${result.stderr}`);
        }
      } catch (err) {
        warn(`${appId}: reconfigure hook on ${target} failed: ${err}`);
      }
    }
  }

  // 4. Persist the new domain to install metadata BEFORE the SSO re-sync.
  //    applyIntegration reloads metadata from disk and computes redirect_uris /
  //    authorize URLs from targetMeta.domain — it MUST see the new domain here.
  meta.domain = newDomain;
  await saveInstallMetadata(meta);

  // 5. Re-sync the homegrown OIDC client(s) to the new domain.
  if (meta.enableSSO) {
    // (a) Base app client: domain-replace its redirect_uris, PRESERVING the secret.
    const baseClientId = meta.ssoClientId || meta.ssoSlug;
    if (baseClientId) {
      try {
        await resyncClientRedirectUris(baseClientId, oldDomain, newDomain);
      } catch (err) {
        warn(`${appId}: failed to re-sync redirect_uris: ${err}`);
      }
    }
    // (b) Integration apps: re-apply each installed identity integration with the
    //     NEW domain context. applyIntegration re-creates the OAuth client and
    //     re-runs the app's SSO setup steps, which rewrite the app's stored
    //     EXTERNAL authorize URL to the new domain.
    if (meta.installedIntegrations?.length && !intentionallyStopped) {
      const { applyIntegration } = await import('@/lib/market/integration-runner');
      for (const integ of meta.installedIntegrations) {
        // Transient failures are common right after a whole-platform restart
        // (container IP not yet resolvable, app still booting) — a failed
        // re-apply leaves the app's stored authorize URL on the OLD domain,
        // so retry before giving up.
        let lastErr: unknown = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          if (attempt > 0) await new Promise((r) => setTimeout(r, 10_000));
          try {
            await applyIntegration({ integrationId: integ.id, sourceId: integ.sourceId }, () => {});
            lastErr = null;
            break;
          } catch (err) {
            lastErr = err;
          }
        }
        if (lastErr) {
          warn(`${appId}: failed to re-apply integration ${integ.id} after 3 attempts: ${lastErr}`);
        }
      }
      // Restart so any cached OIDC client rebuilds from the re-applied config.
      for (const containerName of containerNames) {
        try {
          await incusRequest('PUT', `/1.0/instances/${containerName}/state`, { action: 'restart', force: true, timeout: 30 });
        } catch { /* container may not be running */ }
      }
    }
  }
}

// ─── TLS Target Handling ──────────────────────────────────

/**
 * Apply the TLS target for the new domain. Runs AFTER Caddy routes/subjects are
 * swapped (setDomain resets policies to the internal issuer, so external-cert
 * targets re-load their certificate here).
 */
async function applyTlsTarget(
  target: Exclude<ReconfigureTlsTarget, 'auto'>,
  req: ReconfigureRequest,
  newDomain: string,
  hostIP: string | undefined,
  onEvent: ReconfigureEventCallback,
): Promise<void> {
  const domains = [newDomain, `*.${newDomain}`];

  if (target === 'selfsigned') {
    onEvent({ step: 'tls', status: 'running', message: 'Switching to a self-signed certificate for the new name...' });
    const stored = await tlsStorage.getCert();
    if (stored) {
      await caddy.removeExternalCert();
      await tlsStorage.revertToInternal();
    }
    // A previously connected DNS provider manages the OLD domain — its records
    // and renewal loop are meaningless for the new name. Clear it loudly.
    const providerConfig = await getByoDnsProviderConfig();
    if (providerConfig?.mode === 'byo-provider' && providerConfig.domain !== newDomain) {
      await deleteProviderToken(providerConfig.connectionId).catch(() => {});
      await clearByoDnsProviderConfig();
      onEvent({ step: 'tls', status: 'running', message: `Disconnected the DNS provider for ${providerConfig.domain} (it does not manage ${newDomain})` });
    }
    onEvent({ step: 'tls', status: 'done', message: `Self-signed certificate active — your browser must trust the new certificate for ${newDomain}` });
    return;
  }

  if (target === 'provider') {
    const providerConfig = await getByoDnsProviderConfig();
    if (providerConfig?.mode !== 'byo-provider') {
      throw new Error('No DNS provider is connected — choose the self-signed option or connect a provider first.');
    }
    onEvent({ step: 'dns_provider', status: 'running', message: 'Updating DNS provider records...' });
    const token = await readProviderToken(providerConfig.connectionId);
    if (!token) throw new Error('DNS provider token is not available');
    if (providerConfig.provider !== 'cloudflare') throw new Error(`Unsupported DNS provider: ${providerConfig.provider}`);
    const validation = await validateDnsProvider({
      provider: providerConfig.provider,
      domain: newDomain,
      token,
      writeTest: true,
    });
    if (!validation.ok || !validation.zone) {
      throw new Error(validation.error || 'DNS provider validation failed');
    }
    await saveByoDnsProviderConfig({
      ...providerConfig,
      domain: validation.domain,
      zoneId: validation.zone.id,
      zoneName: validation.zone.name,
      managedRecords: managedAddressNames(validation.domain).map((name) => ({
        type: 'A',
        name,
        content: hostIP || providerConfig.targetIp,
      })),
      targetIp: hostIP || providerConfig.targetIp,
      lastDnsSyncError: '',
    });
    const sync = await syncByoDomainDns('reconfigure', hostIP || providerConfig.targetIp);
    if (!sync.ok) throw new Error(sync.error || 'DNS provider sync failed');
    onEvent({ step: 'dns_provider', status: 'done', message: 'DNS provider records updated' });

    onEvent({ step: 'tls', status: 'running', message: 'Issuing a certificate for the new domain...' });
    const dnsProvider = new CloudflareDnsProvider(token);
    const cert = await issueCertificateWithDnsProvider(validation.domain, dnsProvider, validation.zone, true);
    await caddy.loadExternalCert(cert.certificate, cert.privateKey, cert.domains);
    await tlsStorage.storeCert({
      mode: 'acme',
      certPem: cert.certificate,
      keyPem: cert.privateKey,
      issuer: "Let's Encrypt",
      domains: cert.domains,
      expiresAt: cert.expiresAt,
      issuedAt: new Date().toISOString(),
    });
    const expiresAt = new Date(cert.expiresAt);
    const nextRenewal = new Date(expiresAt.getTime() - 30 * 24 * 60 * 60 * 1000);
    await saveByoDnsProviderConfig({
      ...providerConfig,
      domain: validation.domain,
      zoneId: validation.zone.id,
      zoneName: validation.zone.name,
      targetIp: hostIP || providerConfig.targetIp,
      lastDnsSyncAt: new Date().toISOString(),
      lastCertRenewalAt: new Date().toISOString(),
      nextCertRenewalDueAt: nextRenewal.toISOString(),
      lastDnsSyncError: '',
    });
    onEvent({ step: 'tls', status: 'done', message: 'Certificate issued and loaded' });
    return;
  }

  if (target === 'names-bundle') {
    const bundle = req.namesBundle;
    if (!bundle) throw new Error('YouEye Names bundle missing');
    // Resume the lease + repoint the broker's DNS at this box (DNS-only).
    if (!hostIP || !isPrivateIPv4(hostIP)) {
      throw new Error('Could not determine this server’s private network address. Check its network connection and try again.');
    }
    try {
      await claimName(bundle.name, hostIP, req.namesIdentity);
    } catch (claimErr) {
      if (
        !(claimErr instanceof NamesBrokerError) ||
        claimErr.code !== 'install_already_has_active_lease'
      ) {
        throw claimErr;
      }
      await getLease(bundle.name, req.namesIdentity);
    }
    await updateIp(bundle.name, hostIP, req.namesIdentity);

    if (bundleCertStillValid(bundle)) {
      onEvent({ step: 'tls', status: 'running', message: 'Installing your saved YouEye Names certificate...' });
      await caddy.loadExternalCert(bundle.tls.certPem, bundle.tls.keyPem, domains);
      await tlsStorage.storeCert({
        mode: 'manual',
        certPem: bundle.tls.certPem,
        keyPem: bundle.tls.keyPem,
        issuer: 'YouEye Names',
        domains,
        expiresAt: bundle.certificate.expiresAt,
        issuedAt: bundle.certificate.issuedAt,
      });
    } else {
      onEvent({ step: 'tls', status: 'running', message: 'The saved certificate needs replacement. Requesting a fresh certificate...' });
      const terms = await getCertificateTerms();
      if (!bundle.consent.termsVersion || bundle.consent.termsVersion !== terms.version) {
        throw new NamesBrokerError({
          status: 409,
          code: 'certificate_terms_version_required',
        });
      }
      const generated = await generateCsr(bundle.fqdn);
      await requestCertificate(
        bundle.name,
        generated.csrPem,
        terms.version,
        true,
        req.namesIdentity,
      );
      const deadline = Date.now() + 180_000;
      let issued: Awaited<ReturnType<typeof getCurrentCertificate>> = null;
      let pollDelay = 2_000;
      while (Date.now() < deadline) {
        issued = await getCurrentCertificate(bundle.name, req.namesIdentity);
        if (issued) break;
        await new Promise((resolve) => setTimeout(resolve, pollDelay));
        pollDelay = Math.min(10_000, Math.round(pollDelay * 1.5));
      }
      if (!issued) throw new Error('certificate_not_ready_before_import_deadline');
      const validated = validateCertificateMaterial({
        certificateChain: issued.certificateChain,
        privateKeyPem: generated.keyPem,
        fqdn: bundle.fqdn,
      });
      if (
        validated.brokerFingerprint !== issued.fingerprint ||
        !sameCertificateInstant(validated.expiresAt, issued.expiresAt)
      ) {
        throw new Error('youeye_names_certificate_metadata_mismatch');
      }
      await caddy.loadExternalCert(validated.certificateChain, generated.keyPem, domains);
      await tlsStorage.storeCert({
        mode: 'manual',
        certPem: validated.certificateChain,
        keyPem: generated.keyPem,
        issuer: 'YouEye Names',
        domains,
        expiresAt: validated.expiresAt,
        issuedAt: validated.issuedAt,
      });
    }
    // A DNS provider for a previous BYO domain no longer manages this platform.
    const providerConfig = await getByoDnsProviderConfig();
    if (providerConfig?.mode === 'byo-provider') {
      await deleteProviderToken(providerConfig.connectionId).catch(() => {});
      await clearByoDnsProviderConfig();
    }
    onEvent({ step: 'tls', status: 'done', message: `YouEye Names certificate active for ${newDomain}` });
    return;
  }

  if (target === 'byo-bundle') {
    const bundle = req.byoBundle;
    if (!bundle) throw new Error('Domain bundle missing');
    if (!hostIP || !isPrivateIPv4(hostIP)) {
      throw new Error("Could not determine this server's private network IP. Check HOST_IP and try again.");
    }
    onEvent({ step: 'dns_provider', status: 'running', message: 'Restoring your DNS provider connection...' });

    const token = bundle.dnsToken.included ? (bundle.dnsToken.value || '').trim() : '';
    const connectionId = createConnectionId();
    let config = bundleToProviderConfig(bundle, connectionId, hostIP);

    if (token) {
      await writeProviderToken(connectionId, token);
      const validation = await validateDnsProvider({
        provider: bundle.provider.id,
        domain: bundle.domain,
        token,
        writeTest: true,
      });
      if (!validation.ok || !validation.zone) {
        throw new Error(validation.error || 'DNS provider validation failed');
      }
      config = {
        ...config,
        domain: validation.domain,
        zoneId: validation.zone.id,
        zoneName: validation.zone.name,
        managedRecords: managedAddressNames(validation.domain).map((name) => ({
          type: 'A',
          name,
          content: hostIP,
        })),
      };
      await saveByoDnsProviderConfig(config);
      const sync = await syncByoDomainDns('reconfigure', hostIP);
      if (!sync.ok) throw new Error(sync.error || 'DNS sync failed');
      onEvent({ step: 'dns_provider', status: 'done', message: 'DNS provider records updated' });
    } else {
      await saveByoDnsProviderConfig(config);
      onEvent({ step: 'dns_provider', status: 'done', message: 'Provider restored WITHOUT a DNS token — automatic DNS updates and certificate renewal need the token (re-export the bundle with --include-token, or connect the provider in Settings)' });
    }

    if (bundle.acme.accountKeyPem) {
      await tlsStorage.setAccountKey(bundle.acme.accountKeyPem);
    }

    if (byoDomainBundleCertStillValid(bundle)) {
      onEvent({ step: 'tls', status: 'running', message: 'Reusing your domain certificate...' });
      await tlsStorage.storeCert({
        ...bundle.tls,
        mode: 'acme',
        issuer: bundle.tls.issuer || "Let's Encrypt",
        domains,
        issuedAt: bundle.tls.issuedAt || bundle.exportedAt,
      });
      await caddy.loadExternalCert(bundle.tls.certPem, bundle.tls.keyPem, domains);
      onEvent({ step: 'tls', status: 'done', message: 'Certificate restored and loaded' });
    } else {
      if (!token) {
        throw new Error('The bundled certificate has expired and the bundle has no DNS token to issue a new one. Export a fresh bundle with --include-token.');
      }
      onEvent({ step: 'tls', status: 'running', message: 'Bundled certificate expired — issuing a fresh one...' });
      const dnsProvider = new CloudflareDnsProvider(token);
      const cert = await issueCertificateWithDnsProvider(bundle.domain, dnsProvider, {
        id: bundle.provider.zoneId,
        name: bundle.provider.zoneName,
      }, true);
      await caddy.loadExternalCert(cert.certificate, cert.privateKey, cert.domains);
      await tlsStorage.storeCert({
        mode: 'acme',
        certPem: cert.certificate,
        keyPem: cert.privateKey,
        issuer: "Let's Encrypt",
        domains: cert.domains,
        expiresAt: cert.expiresAt,
        issuedAt: new Date().toISOString(),
      });
      onEvent({ step: 'tls', status: 'done', message: 'Certificate issued and loaded' });
    }
    return;
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

  const hostIP = process.env.HOST_IP;

  // Resolve the effective TLS target up front.
  let tlsTarget: Exclude<ReconfigureTlsTarget, 'auto'>;
  if (req.tls && req.tls !== 'auto') {
    tlsTarget = req.tls;
  } else {
    const providerConfig = await getByoDnsProviderConfig();
    tlsTarget = providerConfig?.mode === 'byo-provider' ? 'provider' : 'selfsigned';
  }

  // 1b. Preflight — does the new name resolve to this server? Warn, never block:
  // the local Pi-Hole rewrite is updated below, but external clients need the
  // owner's DNS to point at this box.
  if (domainChanged) {
    onEvent({ step: 'preflight', status: 'running', message: `Checking DNS for ${newDomain}...` });
    let message: string;
    try {
      const dns = await import('node:dns/promises');
      const addrs = await dns.default.resolve4(newDomain).catch(() => [] as string[]);
      if (addrs.length === 0) {
        message = `${newDomain} does not resolve yet — local DNS will be updated automatically, but external devices need your DNS to point at this server`;
      } else if (hostIP && !addrs.includes(hostIP)) {
        message = `${newDomain} currently resolves to ${addrs[0]}, not ${hostIP} — external devices may not reach the new address until DNS is updated`;
      } else {
        message = `${newDomain} resolves to this server`;
      }
    } catch {
      message = 'DNS preflight skipped';
    }
    onEvent({ step: 'preflight', status: 'done', message });
  }

  // 2. Enumerate installed apps
  onEvent({ step: 'apps', status: 'running', message: 'Enumerating installed apps...' });
  const installedApps = await listInstalledApps();
  onEvent({ step: 'apps', status: 'done', message: `Found ${installedApps.length} installed app(s)` });

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
    // Also ensure TLS subjects are correct. NOTE: setDomain resets TLS automation
    // to the internal issuer — external-cert targets re-load their cert in the
    // TLS step right below.
    await caddy.setDomain(newDomain);
    // Regenerate the canonical root-domain CP-surface routes (/settings, /market
    // + the Referer-gated asset/API support route) from the current generator so
    // allowlist additions reach existing installs on their next URL change.
    await caddy.ensureControlSettingsRoute(newDomain);
    await caddy.ensurePointerInferenceRoutes(newDomain);
    onEvent({ step: 'caddy', status: 'done', message: 'Reverse proxy updated' });

    onEvent({ step: 'ai', status: 'running', message: 'Refreshing YouEye AI identity configuration...' });
    await configurePointerForPlatform();
    onEvent({ step: 'ai', status: 'done', message: 'YouEye AI identity configuration refreshed' });

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

    // 6. TLS for the new name (self-signed regen / provider re-issue / bundle apply)
    if (domainChanged) {
      try {
        await applyTlsTarget(tlsTarget, req, newDomain, hostIP, onEvent);
      } catch (err) {
        console.error('[Reconfigure] TLS update failed:', err);
        onEvent({ step: 'tls', status: 'error', message: err instanceof Error ? err.message : 'TLS update failed' });
        throw err;
      }
    } else {
      // Subdomain-only change: the certificate still covers the domain +
      // wildcard, but setDomain() above reset TLS automation to the internal
      // issuer — restore a stored external cert so it keeps being served.
      const stored = await tlsStorage.getCert();
      if (stored && (stored.mode === 'acme' || stored.mode === 'manual')) {
        await caddy.loadExternalCert(stored.certPem, stored.keyPem, stored.domains);
      }
    }
  }

  // A recovery bundle is also an authority repair. Re-apply it even when the
  // visible domain/subdomain strings already match: the protected identity or
  // encrypted certificate may be missing, stale, or unreadable. Ordinary
  // no-change reconfigure requests still skip TLS work.
  if (
    !domainChanged &&
    !subdomainsChanged &&
    (tlsTarget === 'names-bundle' || tlsTarget === 'byo-bundle')
  ) {
    try {
      await applyTlsTarget(tlsTarget, req, newDomain, hostIP, onEvent);
    } catch (err) {
      console.error('[Reconfigure] TLS authority repair failed:', err);
      onEvent({ step: 'tls', status: 'error', message: err instanceof Error ? err.message : 'TLS authority repair failed' });
      throw err;
    }
  }

  // 7. Defer Control Panel OAuth update until the final env/restart step.
  if (domainChanged || subdomainsChanged) {
    onEvent({ step: 'sso_cp', status: 'running', message: 'Updating Control Panel SSO...' });
    onEvent({ step: 'sso_cp', status: 'done', message: 'Control Panel SSO update deferred until restart step' });
  }

  // 8. Update YouEye ID UI OAuth2 + UI env vars
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

  // 11. Update installed apps (native and market)
  if (domainChanged && installedApps.length > 0) {
    for (const app of installedApps) {
      onEvent({ step: `app_${app.appId}`, status: 'running', message: `Updating ${app.appId}...` });
      const warnings: string[] = [];
      try {
        await updateInstalledApp(app, oldDomain, newDomain, (m) => {
          warnings.push(m);
          console.warn(`[Reconfigure] ${m}`);
        });
        onEvent({
          step: `app_${app.appId}`,
          status: 'done',
          message: warnings.length ? `${app.appId} updated with warnings: ${warnings.join('; ')}` : `${app.appId} updated`,
        });
      } catch (err) {
        console.error(`[Reconfigure] Failed to update app ${app.appId}:`, err);
        onEvent({ step: `app_${app.appId}`, status: 'error', message: `${app.appId} failed: ${err}` });
      }
    }
  }

  // 11b. Propagate system language to installed Market-installed apps
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

  // 12. Restart the identity service so it picks up the new domain immediately
  // (cookie domain and issuer are derived from settings per-request, but the
  // settings cache and any warm OIDC state should not straddle a rename).
  if (domainChanged || subdomainsChanged) {
    onEvent({ step: 'identity', status: 'running', message: 'Restarting YouEye ID...' });
    try {
      const { execFile } = await import('node:child_process');
      await new Promise<void>((resolve, reject) => {
        execFile('systemctl', ['restart', 'youeye-id'], (err) => (err ? reject(err) : resolve()));
      });
      onEvent({ step: 'identity', status: 'done', message: 'YouEye ID restarted' });
    } catch (err) {
      console.warn('[Reconfigure] youeye-id restart failed (non-critical):', err);
      onEvent({ step: 'identity', status: 'done', message: 'YouEye ID restart skipped (it follows settings automatically)' });
    }
  }

  // 13. Update CP SSO env vars — LAST STEP because setControlSSO triggers a 2s delayed restart.
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

  // 14. Build result URL — the user-facing dashboard on the new domain.
  const uiSub = newSubdomains.ui || '';
  const newUrl = uiSub ? `https://${uiSub}.${newDomain}` : `https://${newDomain}`;

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

// ─── Helper: Propagate language env var to a Market-installed app ──

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
