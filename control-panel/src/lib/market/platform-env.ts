/**
 * Canonical Variable Context Builder (v2)
 *
 * Replaces the old buildPlatformEnv() with a declarative system:
 * 1. buildCanonicalContext() — assembles the full VariableContext
 * 2. resolveEnvMapping() — maps canonical vars to app-specific env var names
 * 3. generateAppToken() — creates identity-only JWT for gateway access
 *
 * The platform no longer decides env var names — the manifest's env_mapping
 * section maps canonical variables like ${database.url} to whatever env var
 * name the app expects (e.g., MEMOS_DSN, DATABASE_URL, etc.).
 */

import { settingsService } from '@/lib/settings';
import { readSmtpPassword } from '@/lib/smtp/secrets';
import { getContainerIP } from '@/lib/incus/container-ip';
import { getAuthentikExternalUrl } from './authentik';
import { spineClient } from '@/lib/spine/client';
import { CONTAINER_DOMAIN } from './constants';
import { getContainerName } from './engine-helpers';
import type { AppManifest, InstallConfig, VariableContext } from './types';

// ─── Language Mapping ────────────────────────────────────

const FULL_LANG_NAMES: Record<string, string> = {
  en: 'english', de: 'german', fr: 'french', es: 'spanish',
  it: 'italian', pt: 'portuguese', nl: 'dutch', pl: 'polish',
  ru: 'russian', ja: 'japanese', ko: 'korean', zh: 'chinese',
  ar: 'arabic', hi: 'hindi', tr: 'turkish', sv: 'swedish',
  da: 'danish', no: 'norwegian', fi: 'finnish', cs: 'czech',
  uk: 'ukrainian', ro: 'romanian', hu: 'hungarian', el: 'greek',
  he: 'hebrew', th: 'thai', vi: 'vietnamese', id: 'indonesian',
};

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
  } catch {}

  try {
    const settings = await settingsService.getAll();
    siteName = settings.siteName || siteName;
    domain = settings.domain || domain;
    language = settings.language || language;
  } catch {}

  try {
    const { readFileSync } = await import('fs');
    timezone = readFileSync('/etc/timezone', 'utf-8').trim() || timezone;
  } catch {}

  _platformCtx = { version, domain, siteName, timezone, locale: language };
  _platformCtxTimestamp = now;
  return _platformCtx;
}

export function clearPlatformContextCache(): void {
  _platformCtx = null;
  _platformCtxTimestamp = 0;
}

// ─── App Token (identity-only JWT) ────────────────────────

let _gatewaySecret: string | null = null;

async function getGatewaySecret(): Promise<string> {
  if (_gatewaySecret) return _gatewaySecret;
  try {
    const fs = await import('fs');
    _gatewaySecret = fs.readFileSync('/var/lib/youeye/config/gateway-secret', 'utf-8').trim();
  } catch {
    // Generate and persist if not found
    const crypto = await import('crypto');
    const fs = await import('fs');
    _gatewaySecret = crypto.randomBytes(32).toString('hex');
    try {
      fs.mkdirSync('/var/lib/youeye/config', { recursive: true });
      fs.writeFileSync('/var/lib/youeye/config/gateway-secret', _gatewaySecret, { mode: 0o600 });
    } catch {}
  }
  return _gatewaySecret!;
}

export async function generateAppToken(appId: string): Promise<string> {
  // Simple HMAC-based token (no jsonwebtoken dependency needed)
  const crypto = await import('crypto');
  const secret = await getGatewaySecret();
  const payload = JSON.stringify({ appId, iat: Math.floor(Date.now() / 1000) });
  const payloadB64 = Buffer.from(payload).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
  return `${payloadB64}.${sig}`;
}

export async function validateAppToken(token: string): Promise<{ appId: string } | null> {
  try {
    const crypto = await import('crypto');
    const secret = await getGatewaySecret();
    const [payloadB64, sig] = token.split('.');
    if (!payloadB64 || !sig) return null;
    const expectedSig = crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
    if (sig !== expectedSig) return null;
    return JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
  } catch {
    return null;
  }
}

// ─── Install Param Type Coercion ─────────────────────────

/**
 * Coerce install param values from strings (form input) to their declared types.
 * The manifest's installParams schema declares types; form values arrive as strings.
 * This converts them so env vars and variable resolution use correct types.
 */
export function coerceInstallParams(
  params: Record<string, string>,
  paramDefs: Array<{ name: string; type?: string; default?: string | number | boolean }>,
): Record<string, string> {
  const result: Record<string, string> = { ...params };

  for (const def of paramDefs) {
    const raw = params[def.name];
    if (raw === undefined && def.default !== undefined) {
      // Apply default value
      result[def.name] = String(def.default);
      continue;
    }
    if (raw === undefined) continue;

    switch (def.type) {
      case 'number': {
        const n = Number(raw);
        result[def.name] = isNaN(n) ? raw : String(n);
        break;
      }
      case 'boolean':
        result[def.name] = (raw === 'true' || raw === '1' || raw === 'yes') ? 'true' : 'false';
        break;
      case 'password':
      case 'select':
      case 'string':
      default:
        // Strings stay as-is
        break;
    }
  }

  return result;
}

// ─── Canonical Context Builder ────────────────────────────

export async function buildCanonicalContext(
  manifest: AppManifest,
  config: InstallConfig,
  ssoResult?: { clientId: string; clientSecret: string; slug: string },
  dbPassword?: string,
  appToken?: string,
): Promise<Partial<VariableContext>> {
  const platform = await getPlatformContext();
  const domain = platform.domain || config.domain;
  const fqdn = `${config.subdomain}.${domain}`;
  const appUrl = `https://${fqdn}`;

  // Find primary container for internal_url
  const primaryContainer = manifest.containers.find(c => c.primary) || manifest.containers[0];
  const primaryContainerName = getContainerName(config.appId, primaryContainer?.name || 'main', manifest.containers.length);
  const primaryPort = primaryContainer?.port || 3000;

  // Build containers map
  const containers: Record<string, { internal_host: string; internal_url: string; url: string }> = {};
  for (const c of manifest.containers) {
    const cn = getContainerName(config.appId, c.name, manifest.containers.length);
    const isPrimary = c.primary || manifest.containers.length === 1;
    containers[c.name] = {
      internal_host: `${cn}.${CONTAINER_DOMAIN}`,
      internal_url: c.port ? `http://${cn}.${CONTAINER_DOMAIN}:${c.port}` : `http://${cn}.${CONTAINER_DOMAIN}`,
      url: isPrimary ? `https://${config.subdomain}.${domain}` : '',
    };
  }

  // Authentik URLs
  const authentikExternalUrl = await getAuthentikExternalUrl() || '';
  const authentikIP = await getContainerIP('youeye-authentik');
  const authentikInternalUrl = authentikIP
    ? `http://${authentikIP}:9000`
    : `http://youeye-authentik.${CONTAINER_DOMAIN}:9000`;

  // Caddy proxy IP
  let proxyIp = '';
  try {
    proxyIp = await getContainerIP('youeye-caddy') || '';
  } catch {}

  // Authentik display name
  let authentikDisplayName = `${platform.siteName || 'YouEye'} ID`;

  // SSO slug
  const ssoSlug = ssoResult?.slug || `youeye-app-${config.appId}`;

  const ctx: Partial<VariableContext> = {
    platform: {
      domain,
      version: platform.version,
      locale: platform.locale,
      locale_full: FULL_LANG_NAMES[platform.locale] || platform.locale,
      timezone: platform.timezone,
      site_name: platform.siteName,
      proxy_ip: proxyIp,
    },
    app: {
      id: config.appId,
      name: manifest.metadata.name,
      subdomain: config.subdomain,
      fqdn,
      url: appUrl,
      internal_url: `http://${primaryContainerName}.${CONTAINER_DOMAIN}:${primaryPort}`,
    },
    integration: {
      gateway_url: `http://youeye-ui.${CONTAINER_DOMAIN}:3000/api/apps/v1`,
      app_token: appToken || '',
    },
    containers,
    database: {
      url: '',
      dsn: '',
      host: `youeye-postgres.${CONTAINER_DOMAIN}`,
      port: '5432',
      name: '',
      user: '',
      password: '',
    },
    sso: {
      issuer: ssoResult ? `${authentikExternalUrl}/application/o/${ssoSlug}/` : '',
      discovery_url: ssoResult ? `${authentikExternalUrl}/application/o/${ssoSlug}/.well-known/openid-configuration` : '',
      client_id: ssoResult?.clientId || '',
      client_secret: ssoResult?.clientSecret || '',
      callback_url: manifest.sso ? `${appUrl}${manifest.sso.callback_path}` : '',
      logout_url: ssoResult ? `${authentikExternalUrl}/application/o/${ssoSlug}/end-session/` : '',
    },
    secrets: {},
    installParams: config.installParams || {},

    // Legacy aliases for v1 SSO step compatibility
    install: {
      url: appUrl,
      subdomain: config.subdomain,
      domain,
    },
    authentik: {
      externalUrl: authentikExternalUrl,
      internalUrl: authentikInternalUrl,
      name: authentikDisplayName,
    },
    container: { ip: '', port: primaryPort },
  };

  // Database context
  if (manifest.database?.mode === 'shared' && manifest.database.name && manifest.database.user) {
    const dbHost = `youeye-postgres.${CONTAINER_DOMAIN}`;
    const pw = dbPassword || '';
    ctx.database = {
      url: `postgresql://${manifest.database.user}:${pw}@${dbHost}:5432/${manifest.database.name}`,
      dsn: `postgres://${manifest.database.user}:${pw}@${dbHost}:5432/${manifest.database.name}?sslmode=disable`,
      host: dbHost,
      port: '5432',
      name: manifest.database.name,
      user: manifest.database.user,
      password: pw,
    };
  }

  // SMTP context (if capability declared)
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

const VAR_PATTERN = /\$\{([^}]+)\}/g;

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
    resolved[envVar] = template.replace(VAR_PATTERN, (match, path: string) => {
      const value = resolveContextPath(path.trim(), ctx);
      if (value === undefined) {
        console.warn(`[env_mapping] Unresolved variable: ${match} for env var ${envVar}`);
        return match; // Leave unresolved rather than crashing
      }
      return value;
    });
  }
  return resolved;
}

function resolveContextPath(path: string, ctx: Partial<VariableContext>): string | undefined {
  const parts = path.split('.');
  if (parts.length < 2) return undefined;

  // Walk the context object using dot notation
  let current: unknown = ctx;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }

  if (current === undefined || current === null) return undefined;
  return String(current);
}

// ─── Env File Formatting ──────────────────────────────────

export function envToString(env: Record<string, string>): string {
  return (
    Object.entries(env)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n') + '\n'
  );
}

// ─── Legacy buildPlatformEnv (delegates to v2 for compat) ──

export interface PlatformEnvConfig {
  appId: string;
  subdomain: string;
  domain: string;
  port?: number;
  sso?: { clientId: string; clientSecret: string };
  jwtSecret?: string;
  databaseUrl?: string;
  extra?: Record<string, string>;
}

/**
 * @deprecated Use buildCanonicalContext() + resolveEnvMapping() instead.
 * Kept for any code paths that haven't migrated yet.
 */
export async function buildPlatformEnv(
  config: PlatformEnvConfig,
  manifest?: AppManifest,
): Promise<Record<string, string>> {
  const platform = await getPlatformContext();
  const appUrl = `https://${config.subdomain}.${config.domain}`;
  const appIdUpper = config.appId.replace(/-/g, '_').toUpperCase();

  const env: Record<string, string> = {};
  env.NODE_ENV = 'production';
  env.PORT = String(config.port || 3000);
  env.HOSTNAME = '0.0.0.0';
  env.YOUEYE_APP_ID = config.appId;
  env[`${appIdUpper}_EXTERNAL_URL`] = appUrl;
  env.NEXT_PUBLIC_APP_URL = appUrl;
  env.YOUEYE_API_URL = `http://youeye-ui.${CONTAINER_DOMAIN}:3000/api/v1`;
  env.YOUEYE_UI_URL = `https://${config.domain}`;
  env.CP_API_URL = `http://youeye-control.${CONTAINER_DOMAIN}:3000/api`;
  env.YOUEYE_PLATFORM_VERSION = platform.version;
  env.YOUEYE_DOMAIN = platform.domain || config.domain;
  env.YOUEYE_SITE_NAME = platform.siteName;
  env.YOUEYE_TIMEZONE = platform.timezone;
  env.YOUEYE_LOCALE = platform.locale;
  env.SECURE_COOKIES = 'false';

  if (config.sso) {
    const authentikExternalUrl = await getAuthentikExternalUrl();
    const authentikIP = await getContainerIP('youeye-authentik');
    const authentikInternalUrl = authentikIP
      ? `http://${authentikIP}:9000`
      : `http://youeye-authentik.${CONTAINER_DOMAIN}:9000`;
    env.AUTHENTIK_URL = authentikExternalUrl || '';
    env.AUTHENTIK_INTERNAL_URL = authentikInternalUrl;
    env.AUTHENTIK_CLIENT_ID = config.sso.clientId;
    env.AUTHENTIK_CLIENT_SECRET = config.sso.clientSecret;
  }

  if (config.jwtSecret) env.JWT_SECRET = config.jwtSecret;
  if (config.databaseUrl) env.DATABASE_URL = config.databaseUrl;

  if (config.extra) {
    for (const [key, value] of Object.entries(config.extra)) {
      env[key] = value;
    }
  }

  return env;
}

/**
 * @deprecated Use buildCanonicalContext() instead.
 */
export async function buildVariableContext(
  config: PlatformEnvConfig,
  manifest?: AppManifest,
): Promise<Partial<VariableContext>> {
  // Delegate to the new canonical context builder with a shim config
  const shimConfig: InstallConfig = {
    appId: config.appId,
    subdomain: config.subdomain,
    domain: config.domain,
  };

  // Create a minimal manifest if not provided
  if (!manifest) {
    return buildCanonicalContext({
      apiVersion: 'v2',
      kind: 'app',
      integration: 'basic',
      metadata: { id: config.appId, name: config.appId, description: '', icon: '', category: 'utilities', defaultSubdomain: config.subdomain, tags: [] },
      containers: [],
      env_mapping: {},
      secrets: [],
      configFiles: [],
      installParams: [],
    } as AppManifest, shimConfig);
  }

  return buildCanonicalContext(manifest, shimConfig, config.sso ? {
    clientId: config.sso.clientId,
    clientSecret: config.sso.clientSecret,
    slug: `youeye-app-${config.appId}`,
  } : undefined);
}
