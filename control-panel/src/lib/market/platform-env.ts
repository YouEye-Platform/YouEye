/**
 * Variable context for app manifests and setup files:
 * 1. buildCanonicalContext() — values for the registry's `${…}` names (docs/app-environment.md)
 * 2. resolveEnvMapping() — the app's env with those values substituted
 * 3. generateAppToken() — reads the protected installation credential for gateway access
 */

import { settingsService } from '@/lib/settings';
import { readSmtpPassword } from '@/lib/smtp/secrets';
import { getIdentityProviderConfig } from '@/lib/identity/provider';
import { getAppInternalIdentityBase } from '@/lib/identity/issuer';
import { spineClient } from '@/lib/spine/client';
import { getAppBridgeGatewayIP } from '@/lib/incus/app-network';
import { CONTAINER_DOMAIN } from './constants';
import { getContainerName } from './engine-helpers';
import type { AppManifest, InstallConfig, VariableContext } from './types';
import { withAppLifecycle } from './update-admission';
import { resolvePath } from './variables';
import { youeyeRequirementProblem } from './app-format/requires';

// ─── Platform Config Cache ────────────────────────────────

export interface PlatformContext {
  version: string;
  domain: string;
  siteName: string;
  timezone: string;
  locale: string;
}

let _platformCtx: PlatformContext | null = null;
let _platformCtxTimestamp = 0;
const PLATFORM_CTX_TTL = 10_000;

export async function getPlatformContext(): Promise<PlatformContext> {
  const now = Date.now();
  if (_platformCtx && now - _platformCtxTimestamp < PLATFORM_CTX_TTL) {
    return _platformCtx;
  }

  let version = '0.0.0';
  let siteName = 'YouEye';
  let domain = '';
  let language = 'en';
  let timezone = 'UTC';

  try {
    const spineVersion = await spineClient.version();
    version = spineVersion.version || version;
  } catch (err) {
    console.warn('[platform-env] Failed to fetch Spine version, using default:', err);
  }

  try {
    const settings = await settingsService.getAll();
    siteName = settings.siteName || siteName;
    domain = settings.domain || domain;
    language = settings.language || language;
  } catch (err) {
    console.warn('[platform-env] Failed to fetch platform settings, using defaults:', err);
  }

  try {
    const { readFileSync } = await import('fs');
    timezone = readFileSync('/etc/timezone', 'utf-8').trim() || timezone;
  } catch {
    // Non-critical — defaults to UTC
  }

  _platformCtx = { version, domain, siteName, timezone, locale: language };
  _platformCtxTimestamp = now;
  return _platformCtx;
}

export function clearPlatformContextCache(): void {
  _platformCtx = null;
  _platformCtxTimestamp = 0;
}

// Runtime rendering reads a protected installation credential; it never mints.
export async function generateAppToken(appId: string): Promise<string> {
  return withAppLifecycle(appId, async () => {
  const { appServiceCredentials } = await import('../apps/service-credential-store');
  return appServiceCredentials.runtimeSecret(appId);
  });
}

export async function validateAppToken(token: string, appId: string): Promise<{ appId: string } | null> {
  try {
    const { appServiceCredentials } = await import('../apps/service-credential-store');
    const { readInstallMetadata } = await import('./metadata');
    const metadata = await readInstallMetadata(appId);
    if (!metadata || metadata.enabled !== true || metadata.lifecycleState !== 'active'
      || metadata.serviceCredentialState !== 'ready') return null;
    const credential = await appServiceCredentials.authenticate(appId, token);
    return credential ? { appId: credential.appId } : null;
  } catch {
    return null;
  }
}

// ─── Platform requirement ─────────────────────────────────

/** Refuse an app whose `requires.youeye` is newer than this box's YouEye build. */
export async function assertYouEyeRequirement(manifest: Pick<AppManifest, 'requires'>): Promise<void> {
  if (!manifest.requires) return;
  const problem = youeyeRequirementProblem(manifest.requires, (await getPlatformContext()).version);
  if (problem) throw new Error(problem);
}

// ─── Canonical Context Builder ────────────────────────────

export async function buildCanonicalContext(
  manifest: AppManifest,
  config: Pick<InstallConfig, 'appId' | 'subdomain' | 'domain' | 'aiSettings'>,
  ssoResult?: { clientId: string; clientSecret: string; slug: string },
  dbPassword?: string,
  appToken?: string,
  /** If true, system services are at the app bridge gateway via proxy devices (per-app bridge model) */
  useProxyDevices?: boolean,
): Promise<Partial<VariableContext>> {
  const platform = await getPlatformContext();
  const domain = platform.domain || config.domain;
  const fqdn = `${config.subdomain}.${domain}`;
  const appUrl = `https://${fqdn}`;
  const containerCount = manifest.containers.length;

  const primaryContainer = manifest.containers.find(c => c.primary) || manifest.containers[0];
  const primaryContainerName = getContainerName(config.appId, primaryContainer?.name || 'main', containerCount);
  const primaryPort = primaryContainer?.port || 3000;

  // Sidecars: every container except the app's own.
  const sidecar: VariableContext['sidecar'] = {};
  for (const c of manifest.containers) {
    if (c === primaryContainer) continue;
    const host = `${getContainerName(config.appId, c.name, containerCount)}.${CONTAINER_DOMAIN}`;
    sidecar[c.name] = { host, url: c.port ? `http://${host}:${c.port}` : undefined };
  }

  const identity = await getIdentityProviderConfig();
  let systemProxyHost = '';
  if (useProxyDevices) {
    systemProxyHost = await getAppBridgeGatewayIP(config.appId) || '';
    if (!systemProxyHost) {
      throw new Error(`Cannot build app network context for ${config.appId}: app bridge gateway not found`);
    }
  }
  const identityInternalUrl = useProxyDevices && ssoResult
    ? getAppInternalIdentityBase(ssoResult.slug) || `http://${systemProxyHost}:3002`
    : useProxyDevices ? `http://${systemProxyHost}:3002` : identity.internalUrl;
  const aiEnabled = config.aiSettings?.enabled === true;
  const pointerInferenceBase = aiEnabled && systemProxyHost
    ? `http://${systemProxyHost}:3003`
    : '';

  const identityDisplayName = identity.name || `${platform.siteName || 'YouEye'} ID`;
  const ssoSlug = ssoResult?.slug || `youeye-app-${config.appId}`;
  const sharedDbHost = useProxyDevices ? systemProxyHost : `youeye-postgres.${CONTAINER_DOMAIN}`;

  const ctx: Partial<VariableContext> = {
    platform: {
      domain,
      version: platform.version,
      locale: platform.locale,
      timezone: platform.timezone,
      site_name: platform.siteName,
    },
    app: {
      id: config.appId,
      name: manifest.metadata.name,
      subdomain: config.subdomain,
      fqdn,
      url: appUrl,
      internal_url: `http://${primaryContainerName}.${CONTAINER_DOMAIN}:${primaryPort}`,
    },
    sidecar,
    secret: {},
    youeye: {
      // The per-app bridge gateway carries app→UI traffic. Control Panel owns
      // host-bound proxy devices on that gateway.
      gateway_url: useProxyDevices
        ? `http://${systemProxyHost}:3001/api/apps/v1`
        : 'http://localhost:3001/api/apps/v1',
      app_token: appToken || '',
    },
    database: { url: '', host: sharedDbHost, port: '5432', name: '', user: '', password: '' },
    sso: {
      slug: ssoSlug,
      // Split-channel OIDC. Back-channel (issuer/discovery) rides the app's INTERNAL
      // identity DNAT (http://<app-gw>:3002): domain-free, CA-free, isolation-proof.
      // Front-channel (authorize_url/logout_url) stays external for the browser.
      issuer: ssoResult ? `${identityInternalUrl}/application/o/${ssoSlug}/` : '',
      discovery_url: ssoResult ? `${identityInternalUrl}/application/o/${ssoSlug}/.well-known/openid-configuration` : '',
      authorize_url: ssoResult ? `${identity.externalUrl}/application/o/authorize` : '',
      client_id: ssoResult?.clientId || '',
      client_secret: ssoResult?.clientSecret || '',
      callback_url: manifest.sso
        ? `${appUrl}${manifest.sso.callback_path.replace(/\$\{sso\.slug\}/g, ssoSlug)}`
        : '',
      logout_url: ssoResult ? `${identity.externalUrl}/application/o/${ssoSlug}/end-session/` : '',
      admin_group: manifest.sso?.admin_group ?? 'admin',
    },
    identity: {
      name: identityDisplayName,
      external_url: identity.externalUrl,
      internal_url: identityInternalUrl,
    },
    ai: {
      openai_base_url: pointerInferenceBase ? `${pointerInferenceBase}/v1` : '',
      anthropic_base_url: pointerInferenceBase,
      google_base_url: pointerInferenceBase,
      api_key: aiEnabled ? config.aiSettings?.runtimeCredential || '' : '',
      // Every ${ai.*} is empty while AI Settings are off (docs/app-environment.md).
      default_model: aiEnabled ? 'default' : '',
      utility_model: aiEnabled ? 'utility' : '',
    },
  };

  // Database: the shared YouEye PostgreSQL, or the app's own database sidecar.
  const database = manifest.database;
  if (database?.mode === 'shared' && database.name && database.user) {
    const pw = dbPassword || '';
    ctx.database = {
      url: `postgresql://${database.user}:${pw}@${sharedDbHost}:5432/${database.name}`,
      host: sharedDbHost, port: '5432', name: database.name, user: database.user, password: pw,
    };
  } else if (database?.mode === 'own' && database.container && database.name) {
    const host = sidecar[database.container]?.host ?? '';
    const user = database.user || database.name;
    const pw = dbPassword || '';
    ctx.database = {
      url: `postgresql://${user}:${pw}@${host}:5432/${database.name}`,
      host, port: '5432', name: database.name, user, password: pw,
    };
  }

  // SMTP: only for apps that declare `smtp:`.
  if (manifest.capabilities?.smtp) {
    try {
      const settings = await settingsService.getAll();
      const smtpPassword = await readSmtpPassword();
      ctx.smtp = {
        host: settings.smtpHost || '',
        port: String(settings.smtpPort || 587),
        user: settings.smtpUsername || '',
        password: smtpPassword,
        from: settings.smtpFrom || '',
        security: settings.smtpRequireTls ? 'starttls' : 'none',
      };
    } catch {}
  }

  return ctx;
}

// ─── Env Mapping Resolver ─────────────────────────────────

/**
 * Resolve env_mapping: substitute ${...} references with canonical values.
 * Returns flat Record<string, string> ready for container injection.
 */
export function resolveEnvMapping(
  mapping: Record<string, string>,
  ctx: Partial<VariableContext>,
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [envVar, template] of Object.entries(mapping)) {
    resolved[envVar] = template.replace(/\$\{([^}]+)\}/g, (match, path: string) => {
      const value = resolvePath(path.trim(), ctx);
      if (value === undefined) {
        console.warn(`[env_mapping] Unresolved variable: ${match} for env var ${envVar}`);
        return match; // Leave unresolved rather than crashing
      }
      return value;
    });
  }
  return resolved;
}

// ─── Env File Formatting ──────────────────────────────────

export function envToString(env: Record<string, string>): string {
  return (
    Object.entries(env)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n') + '\n'
  );
}
