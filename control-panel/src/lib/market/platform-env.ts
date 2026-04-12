/**
 * Unified Platform Environment Builder
 *
 * Single source of truth for all environment variables injected into apps
 * (both native and marketplace). Every app gets the same base set of
 * platform variables; capability-conditional variables are added based
 * on manifest declarations.
 *
 * Used by:
 *   - engine.ts (marketplace OCI apps)
 *   - installer.ts (native LXD apps)
 *   - Future Canvas SDK apps (same pipeline)
 */

import { settingsService } from '@/lib/settings';
import { readSmtpPassword } from '@/lib/smtp/secrets';
import { getContainerIP } from '@/lib/incus/container-ip';
import { getAuthentikExternalUrl } from './authentik';
import { spineClient } from '@/lib/spine/client';
import type { AppManifest, VariableContext } from './types';

// ─── Types ────────────────────────────────────────────────

export interface PlatformEnvConfig {
  appId: string;
  subdomain: string;
  domain: string;
  port?: number;

  /** SSO credentials (if SSO was set up for this app) */
  sso?: {
    clientId: string;
    clientSecret: string;
  };

  /** Pre-generated JWT secret */
  jwtSecret?: string;

  /** Pre-generated DATABASE_URL (app-specific, built by caller) */
  databaseUrl?: string;

  /** Extra app-specific env vars (e.g. SEARCH_ENGINE_URL, TMDB_API_KEY) */
  extra?: Record<string, string>;
}

export interface PlatformContext {
  version: string;
  domain: string;
  siteName: string;
  timezone: string;
  locale: string;
}

// ─── Platform Config Cache ────────────────────────────────

let _platformCtx: PlatformContext | null = null;
let _platformCtxTimestamp = 0;
const PLATFORM_CTX_TTL = 10_000; // 10s cache

/**
 * Fetch platform-level config from Spine and settings service.
 * Cached for 10 seconds to avoid hammering Spine on multi-app installs.
 */
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
  } catch {
    // Spine unavailable — use fallback
  }

  try {
    const settings = await settingsService.getAll();
    siteName = settings.siteName || siteName;
    domain = settings.domain || domain;
    language = settings.language || language;
  } catch {
    // Settings unavailable — use defaults
  }

  // Timezone: read from system (Spine runs on same host)
  try {
    const { readFileSync } = await import('fs');
    timezone = readFileSync('/etc/timezone', 'utf-8').trim() || timezone;
  } catch {
    // /etc/timezone not available
  }

  _platformCtx = { version, domain, siteName, timezone, locale: language };
  _platformCtxTimestamp = now;
  return _platformCtx;
}

/** Clear the platform context cache (call after config changes) */
export function clearPlatformContextCache(): void {
  _platformCtx = null;
  _platformCtxTimestamp = 0;
}

// ─── Env Builder ──────────────────────────────────────────

/**
 * Build the complete set of environment variables for an app.
 * This is the canonical list — any variable an app can receive is built here.
 */
export async function buildPlatformEnv(
  config: PlatformEnvConfig,
  manifest?: AppManifest
): Promise<Record<string, string>> {
  const platform = await getPlatformContext();
  const appUrl = `https://${config.subdomain}.${config.domain}`;
  const uiBaseUrl = `https://${config.domain}`;
  const appIdUpper = config.appId.replace(/-/g, '_').toUpperCase();

  const env: Record<string, string> = {};

  // ── Standard runtime ────────────────────────────────────
  env.NODE_ENV = 'production';
  env.PORT = String(config.port || 3000);
  env.HOSTNAME = '0.0.0.0';

  // ── App identity ────────────────────────────────────────
  env.YOUEYE_APP_ID = config.appId;
  env[`${appIdUpper}_EXTERNAL_URL`] = appUrl;
  env.NEXT_PUBLIC_APP_URL = appUrl;

  // ── Platform integration ────────────────────────────────
  env.YOUEYE_API_URL = 'http://youeye-ui.incus:3000/api/v1';
  env.YOUEYE_UI_URL = uiBaseUrl;
  env.CP_API_URL = 'http://youeye-control.incus:3000/api';
  env.YOUEYE_PLATFORM_VERSION = platform.version;
  env.YOUEYE_DOMAIN = platform.domain || config.domain;
  env.YOUEYE_SITE_NAME = platform.siteName;
  env.YOUEYE_TIMEZONE = platform.timezone;
  env.YOUEYE_LOCALE = platform.locale;

  // ── Cookie config ───────────────────────────────────────
  env.SECURE_COOKIES = 'false';

  // ── SSO / Auth ──────────────────────────────────────────
  if (config.sso) {
    const authentikExternalUrl = await getAuthentikExternalUrl();
    const authentikIP = await getContainerIP('youeye-authentik');
    const authentikInternalUrl = authentikIP
      ? `http://${authentikIP}:9000`
      : 'http://youeye-authentik.incus:9000';

    env.AUTHENTIK_URL = authentikExternalUrl || '';
    env.AUTHENTIK_INTERNAL_URL = authentikInternalUrl;
    env.AUTHENTIK_CLIENT_ID = config.sso.clientId;
    env.AUTHENTIK_CLIENT_SECRET = config.sso.clientSecret;
  }

  // ── JWT ─────────────────────────────────────────────────
  if (config.jwtSecret) {
    env.JWT_SECRET = config.jwtSecret;
  }

  // ── Database ────────────────────────────────────────────
  if (config.databaseUrl) {
    env.DATABASE_URL = config.databaseUrl;
  }

  // ── SMTP (capability-conditional) ───────────────────────
  // Instead of injecting raw SMTP credentials (which go stale when settings
  // change), inject the platform mail proxy URL. Apps POST to the proxy;
  // the CP sends the email using current SMTP settings at send time.
  if (manifest?.capabilities?.smtp) {
    env.YOUEYE_MAIL_URL = 'http://youeye-control.incus:3000/api/mail/send';
    env.YOUEYE_MAIL_APP_ID = config.appId;
    // Also inject raw SMTP vars for external apps that use built-in mailers
    // (e.g., Memos). These are best-effort — may go stale until propagation runs.
    try {
      const settings = await settingsService.getAll();
      const smtpPassword = await readSmtpPassword();
      const smtpConfigured = !!(settings.smtpHost && smtpPassword);

      env.SMTP_HOST = settings.smtpHost || '';
      env.SMTP_PORT = String(settings.smtpPort || 587);
      env.SMTP_USERNAME = settings.smtpUsername || '';
      env.SMTP_PASSWORD = smtpPassword;
      env.SMTP_FROM = settings.smtpFrom || '';
      env.SMTP_TLS = String(settings.smtpRequireTls ?? true);
      env.SMTP_CONFIGURED = String(smtpConfigured);
    } catch {
      // SMTP not configured — skip
    }
  }

  // ── Notifications (capability-conditional) ─────────────
  if (manifest?.capabilities?.notifications) {
    env.YOUEYE_NOTIFICATIONS_URL = 'http://youeye-ui.incus:3000/api/v1/notifications';
    env.YOUEYE_NOTIFICATIONS_APP_ID = config.appId;
    // App authenticates via X-App-Slug header using the appId
  }

  // ── Extra app-specific vars ─────────────────────────────
  if (config.extra) {
    for (const [key, value] of Object.entries(config.extra)) {
      env[key] = value;
    }
  }

  return env;
}

/**
 * Build a VariableContext enriched with platform variables.
 * Used by the marketplace engine's template variable resolver.
 */
export async function buildVariableContext(
  config: PlatformEnvConfig,
  manifest?: AppManifest
): Promise<Partial<VariableContext>> {
  const platform = await getPlatformContext();
  const authentikExternalUrl = await getAuthentikExternalUrl();
  const authentikIP = await getContainerIP('youeye-authentik');
  const authentikInternalUrl = authentikIP
    ? `http://${authentikIP}:9000`
    : 'http://youeye-authentik.incus:9000';

  // Read authentik display name
  let authentikDisplayName = '';
  try {
    const settings = await settingsService.getAll();
    authentikDisplayName = `${settings.siteName || 'YouEye'} ID`;
  } catch {
    authentikDisplayName = 'YouEye ID';
  }

  const ctx: Partial<VariableContext> = {
    app: { id: config.appId },
    install: {
      url: `https://${config.subdomain}.${config.domain}`,
      subdomain: config.subdomain,
      domain: config.domain,
    },
    secrets: {},
    container: { ip: '', port: config.port || 0 },
    sso: {
      clientId: config.sso?.clientId || '',
      clientSecret: config.sso?.clientSecret || '',
    },
    authentik: {
      externalUrl: authentikExternalUrl || '',
      internalUrl: authentikInternalUrl,
      name: authentikDisplayName,
    },
    platform: {
      version: platform.version,
      domain: platform.domain || config.domain,
      siteName: platform.siteName,
      timezone: platform.timezone,
      locale: platform.locale,
    },
  };

  // Populate SMTP context if capability declared
  if (manifest?.capabilities?.smtp) {
    try {
      const settings = await settingsService.getAll();
      const smtpPassword = await readSmtpPassword();
      const smtpConfigured = !!(settings.smtpHost && smtpPassword);

      ctx.smtp = {
        host: settings.smtpHost || '',
        port: String(settings.smtpPort || 587),
        username: settings.smtpUsername || '',
        password: smtpPassword,
        from: settings.smtpFrom || '',
        tls: String(settings.smtpRequireTls ?? true),
        configured: String(smtpConfigured),
      };
    } catch {
      // SMTP not configured
    }
  }

  // Populate mail proxy context if SMTP capability declared
  if (manifest?.capabilities?.smtp) {
    ctx.mail = {
      url: 'http://youeye-control.incus:3000/api/mail/send',
      appId: config.appId,
    };
  }

  // Populate notification context if capability declared
  if (manifest?.capabilities?.notifications) {
    ctx.notifications = {
      url: 'http://youeye-ui.incus:3000/api/v1/notifications',
      appId: config.appId,
    };
  }

  return ctx;
}

/**
 * Convert a platform env record to a newline-delimited env file string.
 * Suitable for writing to /etc/{containerName}.env files.
 */
export function envToString(env: Record<string, string>): string {
  return (
    Object.entries(env)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n') + '\n'
  );
}
