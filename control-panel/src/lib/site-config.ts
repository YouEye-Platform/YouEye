/**
 * Site Configuration
 * 
 * Provides site_name and other config from youeye.yaml (via Spine).
 * Server-side: getSiteConfig() calls Spine directly
 * Client-side: useSiteConfig() hook fetches from /api/setup/config
 */

import { settingsService } from '@/lib/settings';

export interface SiteConfig {
  site_name: string;
  domain: string;
  subdomains: Record<string, string>;
  setup_completed: boolean;
}

const DEFAULT_CONFIG: SiteConfig = {
  site_name: 'YouEye',
  domain: '',
  subdomains: {},
  setup_completed: false,
};

/**
 * Server-side: read site config from Spine via SettingsService
 */
export async function getSiteConfig(): Promise<SiteConfig> {
  try {
    const raw = await settingsService.getRaw();
    return { ...DEFAULT_CONFIG, ...raw };
  } catch {
    return DEFAULT_CONFIG;
  }
}
