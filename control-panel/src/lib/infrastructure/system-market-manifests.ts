import { fetchAvailableSystemApps } from '@/lib/market/catalog';
import type { MarketApp } from '@/lib/market/types';
import type { OCIManifest } from './types';

type RequiredSystemAppId = 'postgresql' | 'caddy' | 'pihole';

const REQUIRED_SYSTEM_APPS: Record<RequiredSystemAppId, { containerName: string }> = {
  postgresql: { containerName: 'youeye-postgres' },
  caddy: { containerName: 'youeye-caddy' },
  pihole: { containerName: 'youeye-pihole' },
};

export type SystemImageOverrides = Record<RequiredSystemAppId, {
  image: string;
  version: string;
  sourceId?: string;
  manifestPath?: string;
  manifestDigest?: string;
}>;

function describeSystemItem(item: MarketApp): string {
  return `${item.sourceId || 'unknown-source'}:${item.itemKind || 'unknown'}:${item.id}`;
}

export async function resolveSystemImageOverrides(): Promise<SystemImageOverrides> {
  const systemApps = await fetchAvailableSystemApps();
  const byId = new Map(systemApps.map((item) => [item.id, item]));
  const resolved = {} as SystemImageOverrides;

  for (const [id, expected] of Object.entries(REQUIRED_SYSTEM_APPS) as Array<[RequiredSystemAppId, { containerName: string }]>) {
    const item = byId.get(id);
    if (!item) {
      throw new Error(`Required Market system manifest "${id}" was not found`);
    }
    if (item.itemKind !== 'system') {
      throw new Error(`Market item "${describeSystemItem(item)}" is not a system item`);
    }
    if (!item.system?.image) {
      throw new Error(`Market system manifest "${id}" does not declare system.image`);
    }
    if (item.system.containerName !== expected.containerName) {
      throw new Error(
        `Market system manifest "${id}" containerName mismatch: expected ${expected.containerName}, got ${item.system.containerName || 'missing'}`
      );
    }
    resolved[id] = {
      image: item.system.image,
      version: item.version,
      sourceId: item.sourceId,
      manifestPath: item.manifestPath,
      manifestDigest: item.manifestDigest,
    };
  }

  return resolved;
}

export function applySystemImage(manifest: OCIManifest, system: SystemImageOverrides[RequiredSystemAppId]): OCIManifest {
  return {
    ...manifest,
    image: system.image,
  };
}
