import { randomUUID } from 'crypto';
import { settingsService } from '@/lib/settings';
import type { ByoDnsProviderConfig } from './types';

const CONFIG_KEY = 'dns_provider_config';

export async function getByoDnsProviderConfig(): Promise<ByoDnsProviderConfig | null> {
  const raw = await settingsService.getRaw() as Record<string, unknown>;
  const value = raw[CONFIG_KEY];
  if (!value) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as ByoDnsProviderConfig;
    } catch (error) {
      console.error('[dns-provider] Failed to parse provider config:', error);
      return null;
    }
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    return value as ByoDnsProviderConfig;
  }
  return null;
}

export async function saveByoDnsProviderConfig(config: ByoDnsProviderConfig): Promise<void> {
  await settingsService.setRaw({ [CONFIG_KEY]: JSON.stringify(config) });

  const saved = await getByoDnsProviderConfig();
  if (!saved || saved.connectionId !== config.connectionId || saved.domain !== config.domain) {
    throw new Error('DNS provider config could not be saved. Try connecting the provider again.');
  }
}

export async function clearByoDnsProviderConfig(): Promise<void> {
  await settingsService.setRaw({ [CONFIG_KEY]: '' });
}

export function createConnectionId(): string {
  return `dns-${randomUUID()}`;
}
