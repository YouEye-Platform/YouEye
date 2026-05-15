/**
 * Settings Service
 *
 * Typed abstraction over Spine's youeye.yaml config API.
 * All platform configuration reads/writes go through this service.
 * The underlying transport remains spineClient — this adds typing and caching.
 */

import { spineClient } from '../spine/client';

export interface PlatformSettings {
  siteName: string;
  domain: string;
  subdomains: Record<string, string>;
  setupCompleted: boolean;
  releaseBranch?: string;
  language?: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpUsername?: string;
  smtpFrom?: string;
  smtpRequireTls?: boolean;
}

/** Maps PlatformSettings keys to youeye.yaml snake_case keys */
const KEY_MAP: Record<keyof PlatformSettings, string> = {
  siteName: 'site_name',
  domain: 'domain',
  subdomains: 'subdomains',
  setupCompleted: 'setup_completed',
  releaseBranch: 'release_branch',
  language: 'language',
  smtpHost: 'smtp_host',
  smtpPort: 'smtp_port',
  smtpUsername: 'smtp_username',
  smtpFrom: 'smtp_from',
  smtpRequireTls: 'smtp_require_tls',
};

/** Maps youeye.yaml snake_case keys back to PlatformSettings keys */
const REVERSE_KEY_MAP: Record<string, keyof PlatformSettings> = Object.fromEntries(
  Object.entries(KEY_MAP).map(([k, v]) => [v, k as keyof PlatformSettings])
) as Record<string, keyof PlatformSettings>;

/** Convert raw Spine config to typed PlatformSettings */
function fromRaw(raw: Record<string, unknown>): PlatformSettings {
  return {
    siteName: (raw.site_name as string) || '',
    domain: (raw.domain as string) || '',
    subdomains: (raw.subdomains as Record<string, string>) || {},
    setupCompleted: (raw.setup_completed as boolean) || false,
    releaseBranch: raw.release_branch as string | undefined,
    language: raw.language as string | undefined,
    smtpHost: raw.smtp_host as string | undefined,
    smtpPort: raw.smtp_port as number | undefined,
    smtpUsername: raw.smtp_username as string | undefined,
    smtpFrom: raw.smtp_from as string | undefined,
    smtpRequireTls: raw.smtp_require_tls as boolean | undefined,
  };
}

/** Convert typed patch to raw snake_case for Spine API */
function toRawPatch(patch: Partial<PlatformSettings>): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    const rawKey = KEY_MAP[key as keyof PlatformSettings];
    if (rawKey !== undefined && value !== undefined) {
      raw[rawKey] = value;
    }
  }
  return raw;
}

class SettingsService {
  private cache: PlatformSettings | null = null;
  private cacheTimestamp: number = 0;
  private readonly CACHE_TTL_MS = 5000; // 5 second cache

  /** Get all settings, with short-lived cache to avoid hammering Spine */
  async getAll(): Promise<PlatformSettings> {
    const now = Date.now();
    if (this.cache && (now - this.cacheTimestamp) < this.CACHE_TTL_MS) {
      return this.cache;
    }
    const raw = await spineClient.getConfig();
    const settings = fromRaw(raw as unknown as Record<string, unknown>);
    this.cache = settings;
    this.cacheTimestamp = now;
    return settings;
  }

  /** Get a single typed setting */
  async get<K extends keyof PlatformSettings>(key: K): Promise<PlatformSettings[K]> {
    const all = await this.getAll();
    return all[key];
  }

  /** Update one or more settings (PATCH — preserves other fields) */
  async set(patch: Partial<PlatformSettings>): Promise<PlatformSettings> {
    const rawPatch = toRawPatch(patch);
    await spineClient.patchConfig(rawPatch);
    this.cache = null; // Invalidate cache
    return this.getAll();
  }

  /**
   * Update settings using raw snake_case keys.
   * Use this for call sites that already have raw config objects
   * (e.g. setup wizard, reconfigure) to avoid double-conversion.
   */
  async setRaw(rawPatch: Record<string, unknown>): Promise<void> {
    await spineClient.patchConfig(rawPatch);
    this.cache = null;
  }

  /**
   * Get the raw Spine config (snake_case keys).
   * Use this for call sites that need the raw format
   * (e.g. setup/config endpoint, bridge endpoints).
   */
  async getRaw(): Promise<{ site_name: string; domain: string; subdomains: Record<string, string>; setup_completed: boolean; release_branch?: string; language?: string; smtp_host?: string; smtp_port?: number; smtp_username?: string; smtp_from?: string; smtp_require_tls?: boolean; [key: string]: unknown }> {
    const now = Date.now();
    if (this.cache && (now - this.cacheTimestamp) < this.CACHE_TTL_MS) {
      // Convert cached typed settings back to raw
      return {
        site_name: this.cache.siteName,
        domain: this.cache.domain,
        subdomains: this.cache.subdomains,
        setup_completed: this.cache.setupCompleted,
        release_branch: this.cache.releaseBranch,
        language: this.cache.language,
        smtp_host: this.cache.smtpHost,
        smtp_port: this.cache.smtpPort,
        smtp_username: this.cache.smtpUsername,
        smtp_from: this.cache.smtpFrom,
        smtp_require_tls: this.cache.smtpRequireTls,
      };
    }
    const raw = await spineClient.getConfig();
    // Also populate the typed cache
    this.cache = fromRaw(raw as unknown as Record<string, unknown>);
    this.cacheTimestamp = Date.now();
    return raw as Awaited<ReturnType<typeof this.getRaw>>;
  }

  /** Invalidate the cache (call after external config changes) */
  invalidate(): void {
    this.cache = null;
  }
}

// Singleton
export const settingsService = new SettingsService();
