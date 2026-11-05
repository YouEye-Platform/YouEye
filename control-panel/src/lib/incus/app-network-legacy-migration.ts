import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';
import { AppNetworkStateError } from './app-network-ipam';

export const LEGACY_APP_NETWORK_REGISTRY_PATH = '/var/lib/youeye/networks/subnets.json';

export interface LegacySubnetRegistry {
  next: number;
  allocated: Record<string, number>;
}

export interface LegacyIncusNetwork {
  name: string;
  description?: string;
  type?: string;
  managed?: boolean;
  config?: Record<string, string>;
  used_by?: string[];
}

export interface LegacyIncusInstance {
  name: string;
  devices?: Record<string, Record<string, string>>;
}

const APP_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const OWNERSHIP_KEYS = [
  'user.youeye.kind',
  'user.youeye.app_id',
  'user.youeye.cidr',
  'user.youeye.operation_id',
] as const;

function plainObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppNetworkStateError(`${label} must be an object`);
  }
}

/** Strictly parse the retired appId -> 10.76.<N>.0/24 allocator registry. */
export function parseLegacySubnetRegistry(value: unknown): LegacySubnetRegistry {
  plainObject(value, 'Legacy app network registry');
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== 'allocated' || keys[1] !== 'next') {
    throw new AppNetworkStateError('Legacy app network registry has an unfamiliar shape');
  }
  if (!Number.isInteger(value.next) || Number(value.next) < 1 || Number(value.next) > 255) {
    throw new AppNetworkStateError('Legacy app network registry next value is invalid');
  }
  plainObject(value.allocated, 'Legacy app network allocations');
  const allocated: Record<string, number> = {};
  const bridgeIds = new Set<number>();
  for (const [appId, bridgeId] of Object.entries(value.allocated)) {
    if (!APP_ID.test(appId) || !Number.isInteger(bridgeId) || Number(bridgeId) < 1 || Number(bridgeId) > 254) {
      throw new AppNetworkStateError('Legacy app network registry contains an invalid allocation');
    }
    if (bridgeIds.has(Number(bridgeId))) {
      throw new AppNetworkStateError('Legacy app network registry reuses a bridge identity');
    }
    allocated[appId] = Number(bridgeId);
    bridgeIds.add(Number(bridgeId));
  }
  if (Object.keys(allocated).length === 0) {
    throw new AppNetworkStateError('Legacy app network registry is empty');
  }
  return { next: Number(value.next), allocated };
}

/**
 * Read only the exact root-owned, non-writable legacy file shape. The new
 * allocator later makes the parent private, so both the retired 0755 and the
 * hardened 0700 directory modes are accepted for restart-safe migration.
 */
export async function readLegacySubnetRegistry(
  inputPath = LEGACY_APP_NETWORK_REGISTRY_PATH,
): Promise<LegacySubnetRegistry> {
  if (typeof process.geteuid !== 'function') {
    throw new AppNetworkStateError('Legacy app network migration requires POSIX ownership checks');
  }
  const expectedUid = process.geteuid();
  const directory = path.dirname(inputPath);
  const [fileStat, directoryStat] = await Promise.all([lstat(inputPath), lstat(directory)]);
  const directoryMode = directoryStat.mode & 0o777;
  if (!directoryStat.isDirectory()
    || directoryStat.uid !== expectedUid
    || ![0o700, 0o755].includes(directoryMode)) {
    throw new AppNetworkStateError('Legacy app network state directory is not the exact trusted shape');
  }
  if (!fileStat.isFile() || fileStat.uid !== expectedUid || (fileStat.mode & 0o777) !== 0o644) {
    throw new AppNetworkStateError('Legacy app network registry is not the exact trusted file shape');
  }
  const handle = await open(inputPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== fileStat.dev || opened.ino !== fileStat.ino) {
      throw new AppNetworkStateError('Legacy app network registry changed while opening');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await handle.readFile('utf8'));
    } catch {
      throw new AppNetworkStateError('Legacy app network registry is corrupt');
    }
    return parseLegacySubnetRegistry(parsed);
  } finally {
    await handle.close();
  }
}

export function assertLegacyNetworkCandidate(input: {
  appId: string;
  bridgeId: number;
  network: LegacyIncusNetwork;
  containerNames: string[];
  instances: LegacyIncusInstance[];
  caddy: LegacyIncusInstance;
  piholeIP: string;
}): void {
  const { appId, bridgeId, network } = input;
  const bridgeName = `yeapp${bridgeId}`;
  const cidr = `10.76.${bridgeId}.0/24`;
  const operationId = `legacy-subnets-v1:${appId}:${bridgeId}`;
  if (network.name !== bridgeName || network.type !== 'bridge' || network.managed !== true) {
    throw new AppNetworkStateError(`Legacy bridge proof failed for ${appId}: managed bridge identity mismatch`);
  }
  if (!['', `App network: ${appId}`].includes(network.description ?? '')) {
    throw new AppNetworkStateError(`Legacy bridge proof failed for ${appId}: unfamiliar description`);
  }
  if (!Array.isArray(input.containerNames)
    || input.containerNames.length === 0
    || new Set(input.containerNames).size !== input.containerNames.length
    || input.containerNames.some((name) => !/^app-[a-z0-9][a-z0-9-]{0,80}$/.test(name))) {
    throw new AppNetworkStateError(`Legacy bridge proof failed for ${appId}: invalid recorded containers`);
  }
  const config = network.config ?? {};
  const requiredConfig: Record<string, string> = {
    'dns.domain': 'youeye',
    'ipv4.address': `10.76.${bridgeId}.1/24`,
    'ipv4.dhcp': 'true',
    'ipv6.address': 'none',
    'raw.dnsmasq': `server=${input.piholeIP}`,
  };
  for (const [key, expected] of Object.entries(requiredConfig)) {
    if (config[key] !== expected) {
      throw new AppNetworkStateError(`Legacy bridge proof failed for ${appId}: ${key} mismatch`);
    }
  }
  if (!['true', 'false'].includes(config['ipv4.nat'])) {
    throw new AppNetworkStateError(`Legacy bridge proof failed for ${appId}: ipv4.nat mismatch`);
  }
  const allowedKeys = new Set([...Object.keys(requiredConfig), 'ipv4.nat', ...OWNERSHIP_KEYS]);
  if (Object.keys(config).some((key) => !allowedKeys.has(key))) {
    throw new AppNetworkStateError(`Legacy bridge proof failed for ${appId}: unfamiliar bridge configuration`);
  }
  const expectedOwnership: Record<(typeof OWNERSHIP_KEYS)[number], string> = {
    'user.youeye.kind': 'app-network',
    'user.youeye.app_id': appId,
    'user.youeye.cidr': cidr,
    'user.youeye.operation_id': operationId,
  };
  const presentOwnership = OWNERSHIP_KEYS.filter((key) => config[key] !== undefined);
  if (presentOwnership.length > 0
    && OWNERSHIP_KEYS.some((key) => config[key] !== expectedOwnership[key])) {
    throw new AppNetworkStateError(`Legacy bridge proof failed for ${appId}: ownership metadata is partial or different`);
  }
  const expectedUsedBy = [...input.containerNames, 'youeye-caddy']
    .map((name) => `/1.0/instances/${name}`).sort();
  const usedBy = [...(network.used_by ?? [])].sort();
  if (new Set(usedBy).size !== usedBy.length
    || usedBy.length !== expectedUsedBy.length
    || usedBy.some((value, index) => value !== expectedUsedBy[index])) {
    throw new AppNetworkStateError(`Legacy bridge proof failed for ${appId}: attached instances differ from metadata`);
  }
  const instancesByName = new Map(input.instances.map((instance) => [instance.name, instance]));
  for (const containerName of input.containerNames) {
    const instance = instancesByName.get(containerName);
    const attachments = Object.values(instance?.devices ?? {})
      .filter((device) => device.type === 'nic' && device.network === bridgeName);
    if (attachments.length !== 1) {
      throw new AppNetworkStateError(`Legacy bridge proof failed for ${appId}: ${containerName} attachment mismatch`);
    }
  }
  const caddyDevice = input.caddy.devices?.[`net-${appId}`];
  if (!caddyDevice || caddyDevice.type !== 'nic' || caddyDevice.network !== bridgeName) {
    throw new AppNetworkStateError(`Legacy bridge proof failed for ${appId}: Caddy attachment mismatch`);
  }
}
