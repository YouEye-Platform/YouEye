import { fetchAvailableSystemApps } from '@/lib/market/catalog';
import type { MarketApp } from '@/lib/market/types';
import type { OCIManifest } from './types';
import { incusRequest } from '@/lib/incus/server';

type RequiredSystemAppId = 'postgresql' | 'caddy' | 'pihole';

const REQUIRED_SYSTEM_APPS: Record<RequiredSystemAppId, { containerName: string }> = {
  postgresql: { containerName: 'youeye-postgres' },
  caddy: { containerName: 'youeye-caddy' },
  pihole: { containerName: 'youeye-pihole' },
};

export const REQUIRED_SYSTEM_APP_IDS = Object.keys(REQUIRED_SYSTEM_APPS) as RequiredSystemAppId[];

export type SystemImageOverrides = Record<RequiredSystemAppId, {
  image: string;
  version: string;
  sourceId?: string;
  manifestPath?: string;
  manifestDigest?: string;
}>;

export function getRequiredSystemContainerName(id: RequiredSystemAppId): string {
  return REQUIRED_SYSTEM_APPS[id].containerName;
}

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

export async function recordSystemContainerManifest(
  id: RequiredSystemAppId,
  system: SystemImageOverrides[RequiredSystemAppId],
): Promise<void> {
  const containerName = getRequiredSystemContainerName(id);
  const config: Record<string, string> = {
    'user.youeye.market.system_id': id,
    'user.youeye.market.image': system.image,
    'user.youeye.market.version': system.version,
    'user.youeye.market.updated_at': new Date().toISOString(),
  };

  if (system.sourceId) config['user.youeye.market.source_id'] = system.sourceId;
  if (system.manifestPath) config['user.youeye.market.manifest_path'] = system.manifestPath;
  if (system.manifestDigest) config['user.youeye.market.manifest_digest'] = system.manifestDigest;

  const result = await incusRequest<Record<string, unknown>>(
    'PATCH',
    `/1.0/instances/${containerName}`,
    { config },
    { timeout: 30_000 },
  );

  if (result.error) {
    throw new Error(`Failed to record Market metadata on ${containerName}: ${result.error}`);
  }
}
