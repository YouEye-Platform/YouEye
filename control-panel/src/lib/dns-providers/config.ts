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
  await settingsService.setRaw({ [CONFIG_KEY]: config });
}

export async function clearByoDnsProviderConfig(): Promise<void> {
  await settingsService.setRaw({ [CONFIG_KEY]: null });
}

export function createConnectionId(): string {
  return `dns-${randomUUID()}`;
}
