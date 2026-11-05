import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
} from 'fs/promises';
import { randomUUID } from 'crypto';
import path from 'path';

export const APP_NETWORK_IPAM_SCHEMA = 'youeye.app-network-ipam/1';
export const DEFAULT_APP_NETWORK_POOLS = ['10.76.0.0/16'] as const;
export const APP_NETWORK_POOL_CANDIDATES = [
  '10.76.0.0/16',
  '10.77.0.0/16',
  '10.78.0.0/16',
  '10.79.0.0/16',
  '10.80.0.0/16',
  '10.81.0.0/16',
  '10.82.0.0/16',
  '10.83.0.0/16',
] as const;
export const DEFAULT_APP_NETWORK_PREFIX = 27;
export const DEFAULT_APP_NETWORK_STATE_PATH = '/var/lib/youeye/networks/ipam.json';
export const LEGACY_APP_NETWORK_MIGRATION_SOURCE = 'subnets.json/v1';

export type AppNetworkLeaseState = 'reserved' | 'active' | 'cleanup_pending';

export interface AppNetworkConfig {
  pools: string[];
  allocationPrefix: number;
  excludedCIDRs?: string[];
}

export interface AppNetworkLease {
  appId: string;
  bridgeId: number;
  bridgeName: string;
  cidr: string;
  gateway: string;
  state: AppNetworkLeaseState;
  operationId: string;
  requiredAddresses: number;
  createdAt: string;
  updatedAt: string;
  /** Exact provenance for in-place imports of the retired 10.76.<N>.0/24 allocator. */
  importedFrom?: typeof LEGACY_APP_NETWORK_MIGRATION_SOURCE;
  failure?: {
    stage: string;
    message: string;
    observedAt: string;
  };
}

export interface AppNetworkIpamState {
  schema: typeof APP_NETWORK_IPAM_SCHEMA;
  allocationPrefix: number;
  pools: string[];
  leases: AppNetworkLease[];
  updatedAt: string;
}

export interface CidrRange {
  cidr: string;
  network: number;
  broadcast: number;
  prefix: number;
  size: number;
}

export class AppNetworkStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppNetworkStateError';
  }
}

export class AppNetworkCapacityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppNetworkCapacityError';
  }
}

export class AppNetworkOperationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppNetworkOperationConflictError';
  }
}

function assertPlainObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppNetworkStateError(`${label} must be an object`);
  }
}

function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AppNetworkStateError(`${label} must be a non-empty string`);
  }
}

function assertInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isInteger(value)) {
    throw new AppNetworkStateError(`${label} must be an integer`);
  }
}

export function parseIPv4(value: string): number {
  const parts = value.split('.');
  if (parts.length !== 4) throw new AppNetworkStateError(`Invalid IPv4 address: ${value}`);
  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) throw new AppNetworkStateError(`Invalid IPv4 address: ${value}`);
    const octet = Number(part);
    if (octet < 0 || octet > 255) throw new AppNetworkStateError(`Invalid IPv4 address: ${value}`);
    result = ((result << 8) | octet) >>> 0;
  }
  return result >>> 0;
}

export function formatIPv4(value: number): string {
  const ip = value >>> 0;
  return [ip >>> 24, (ip >>> 16) & 255, (ip >>> 8) & 255, ip & 255].join('.');
}

function prefixMask(prefix: number): number {
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    throw new AppNetworkStateError(`Invalid IPv4 prefix: ${prefix}`);
  }
  return prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
}

export function parseCIDR(value: string): CidrRange {
  const match = value.match(/^([^/]+)\/(\d{1,2})$/);
  if (!match) throw new AppNetworkStateError(`Invalid IPv4 CIDR: ${value}`);
  const address = parseIPv4(match[1]);
  const prefix = Number(match[2]);
  const mask = prefixMask(prefix);
  const network = (address & mask) >>> 0;
  if (address !== network) {
    throw new AppNetworkStateError(`CIDR must use its network address: ${value}`);
  }
  const size = 2 ** (32 - prefix);
  const broadcast = (network + size - 1) >>> 0;
  return { cidr: `${formatIPv4(network)}/${prefix}`, network, broadcast, prefix, size };
}

export function cidrContains(container: string, candidate: string): boolean {
  const outer = parseCIDR(container);
  const inner = parseCIDR(candidate);
  return inner.network >= outer.network && inner.broadcast <= outer.broadcast;
}

export function cidrOverlaps(left: string, right: string): boolean {
  const a = parseCIDR(left);
  const b = parseCIDR(right);
  return a.network <= b.broadcast && b.network <= a.broadcast;
}

/**
 * Select exactly one bounded, deterministic private pool that does not overlap
 * the proved host/Incus inventory. Exhaustion is a hard failure: the planner
 * must never invent a route or silently accept an overlap.
 */
export function selectAppNetworkPools(
  candidates: readonly string[],
  externalCIDRs: readonly string[],
): string[] {
  if (candidates.length === 0) {
    throw new AppNetworkCapacityError('No app network pool candidates are configured');
  }
  const normalizedExternal = externalCIDRs.map((cidr) => parseCIDR(cidr).cidr);
  const normalizedCandidates = candidates.map((candidate) => {
    const parsed = parseCIDR(candidate);
    if (parsed.prefix > DEFAULT_APP_NETWORK_PREFIX) {
      throw new AppNetworkStateError(
        `App network pool candidate ${parsed.cidr} is smaller than /${DEFAULT_APP_NETWORK_PREFIX} allocations`,
      );
    }
    return parsed.cidr;
  });
  if (new Set(normalizedCandidates).size !== normalizedCandidates.length) {
    throw new AppNetworkStateError('App network pool candidates must be unique');
  }
  const selected = normalizedCandidates.find(
    (candidate) => normalizedExternal.every((external) => !cidrOverlaps(candidate, external)),
  );
  if (!selected) {
    throw new AppNetworkCapacityError(
      `No safe app network pool remains in the bounded candidate set (${normalizedCandidates.join(', ')})`,
    );
  }
  return [selected];
}

export function cidrUsableAddresses(cidr: string): number {
  const range = parseCIDR(cidr);
  return Math.max(0, range.size - 2);
}

export function firstHost(cidr: string): string {
  const range = parseCIDR(cidr);
  if (range.size < 4) throw new AppNetworkStateError(`CIDR has no usable gateway address: ${cidr}`);
  return formatIPv4((range.network + 1) >>> 0);
}

export function cidrComplement(poolCIDR: string, excludedCIDR: string): string[] {
  const pool = parseCIDR(poolCIDR);
  const excluded = parseCIDR(excludedCIDR);
  if (!cidrContains(pool.cidr, excluded.cidr)) {
    throw new AppNetworkStateError(`${excluded.cidr} is not contained in ${pool.cidr}`);
  }

  const output: string[] = [];
  const walk = (network: number, prefix: number): void => {
    const cidr = `${formatIPv4(network)}/${prefix}`;
    if (!cidrOverlaps(cidr, excluded.cidr)) {
      output.push(cidr);
      return;
    }
    if (prefix === excluded.prefix) return;
    const childPrefix = prefix + 1;
    const childSize = 2 ** (32 - childPrefix);
    walk(network, childPrefix);
    walk((network + childSize) >>> 0, childPrefix);
  };

  walk(pool.network, pool.prefix);
  return output;
}

export function validateAppNetworkConfig(config: AppNetworkConfig): AppNetworkConfig {
  if (!Number.isInteger(config.allocationPrefix) || config.allocationPrefix < 8 || config.allocationPrefix > 30) {
    throw new AppNetworkStateError(`App network allocation prefix must be between /8 and /30, got /${config.allocationPrefix}`);
  }
  if (!Array.isArray(config.pools) || config.pools.length === 0) {
    throw new AppNetworkStateError('At least one app network pool is required');
  }
  const pools = config.pools.map((pool, index) => {
    assertString(pool, `pools[${index}]`);
    const parsed = parseCIDR(pool);
    if (parsed.prefix > config.allocationPrefix) {
      throw new AppNetworkStateError(`${parsed.cidr} is smaller than /${config.allocationPrefix} allocations`);
    }
    return parsed.cidr;
  }).sort((left, right) => parseCIDR(left).network - parseCIDR(right).network);
  if (new Set(pools).size !== pools.length) {
    throw new AppNetworkStateError('App network pools must be unique');
  }
  for (let left = 0; left < pools.length; left++) {
    for (let right = left + 1; right < pools.length; right++) {
      if (cidrOverlaps(pools[left], pools[right])) {
        throw new AppNetworkStateError(`App network pools overlap: ${pools[left]} and ${pools[right]}`);
      }
    }
  }
  const excludedCIDRs = (config.excludedCIDRs ?? []).map((cidr, index) => {
    assertString(cidr, `excludedCIDRs[${index}]`);
    return parseCIDR(cidr).cidr;
  }).sort((left, right) => parseCIDR(left).network - parseCIDR(right).network);
  if (new Set(excludedCIDRs).size !== excludedCIDRs.length) {
    throw new AppNetworkStateError('Excluded app network CIDRs must be unique');
  }
  return { pools, allocationPrefix: config.allocationPrefix, excludedCIDRs };
}

/** Parse Linux /proc/net/route IPv4 entries into normalized main-table CIDRs. */
export function parseProcNetRoute(value: string): string[] {
  const routes = new Set<string>();
  const lines = value.trim().split(/\r?\n/).slice(1);
  const fromLittleEndianHex = (hex: string): number => {
    if (!/^[0-9A-Fa-f]{8}$/.test(hex)) {
      throw new AppNetworkStateError(`Invalid /proc/net/route IPv4 value: ${hex}`);
    }
    const bytes = hex.match(/../g)!.reverse();
    return parseIPv4(bytes.map((byte) => Number.parseInt(byte, 16)).join('.'));
  };
  for (const line of lines) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 8) continue;
    const destination = fromLittleEndianHex(columns[1]);
    const mask = fromLittleEndianHex(columns[7]);
    if (destination === 0 && mask === 0) continue;
    let prefix = 0;
    let zeroSeen = false;
    for (let bit = 31; bit >= 0; bit--) {
      const set = ((mask >>> bit) & 1) === 1;
      if (set && zeroSeen) {
        throw new AppNetworkStateError(`Non-contiguous host route mask: ${columns[7]}`);
      }
      if (set) prefix++;
      else zeroSeen = true;
    }
    routes.add(parseCIDR(`${formatIPv4((destination & mask) >>> 0)}/${prefix}`).cidr);
  }
  return [...routes].sort((left, right) => parseCIDR(left).network - parseCIDR(right).network);
}

function validateFailure(value: unknown, label: string): AppNetworkLease['failure'] {
  if (value === undefined) return undefined;
  assertPlainObject(value, label);
  assertString(value.stage, `${label}.stage`);
  assertString(value.message, `${label}.message`);
  assertString(value.observedAt, `${label}.observedAt`);
  return { stage: value.stage, message: value.message, observedAt: value.observedAt };
}

function validateLease(value: unknown, index: number, allocationPrefix: number, pools: string[]): AppNetworkLease {
  const label = `leases[${index}]`;
  assertPlainObject(value, label);
  assertString(value.appId, `${label}.appId`);
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(value.appId)) {
    throw new AppNetworkStateError(`${label}.appId is invalid`);
  }
  assertInteger(value.bridgeId, `${label}.bridgeId`);
  if (value.bridgeId < 1 || value.bridgeId > 9_999_999) {
    throw new AppNetworkStateError(`${label}.bridgeId is outside the supported range`);
  }
  assertString(value.bridgeName, `${label}.bridgeName`);
  if (value.bridgeName !== `yeapp${value.bridgeId}`) {
    throw new AppNetworkStateError(`${label}.bridgeName does not match bridgeId`);
  }
  assertString(value.cidr, `${label}.cidr`);
  const cidr = parseCIDR(value.cidr);
  const importedFrom = value.importedFrom;
  if (importedFrom === undefined) {
    if (cidr.prefix !== allocationPrefix) {
      throw new AppNetworkStateError(`${label}.cidr must use /${allocationPrefix}`);
    }
  } else {
    if (importedFrom !== LEGACY_APP_NETWORK_MIGRATION_SOURCE) {
      throw new AppNetworkStateError(`${label}.importedFrom is invalid`);
    }
    const expectedCIDR = `10.76.${value.bridgeId}.0/24`;
    if (value.bridgeId > 254 || cidr.cidr !== expectedCIDR) {
      throw new AppNetworkStateError(`${label} is not an exact legacy /24 lease`);
    }
  }
  if (!pools.some((pool) => cidrContains(pool, cidr.cidr))) {
    throw new AppNetworkStateError(`${label}.cidr is not contained in a configured pool`);
  }
  assertString(value.gateway, `${label}.gateway`);
  const gateway = parseIPv4(value.gateway);
  if (gateway <= cidr.network || gateway >= cidr.broadcast) {
    throw new AppNetworkStateError(`${label}.gateway is outside the usable lease range`);
  }
  if (!['reserved', 'active', 'cleanup_pending'].includes(String(value.state))) {
    throw new AppNetworkStateError(`${label}.state is invalid`);
  }
  assertString(value.operationId, `${label}.operationId`);
  assertInteger(value.requiredAddresses, `${label}.requiredAddresses`);
  if (value.requiredAddresses < 1 || value.requiredAddresses > cidrUsableAddresses(cidr.cidr)) {
    throw new AppNetworkStateError(`${label}.requiredAddresses exceeds lease capacity`);
  }
  assertString(value.createdAt, `${label}.createdAt`);
  assertString(value.updatedAt, `${label}.updatedAt`);
  if (importedFrom === LEGACY_APP_NETWORK_MIGRATION_SOURCE) {
    if (value.gateway !== `10.76.${value.bridgeId}.1`
      || value.state !== 'active'
      || value.operationId !== `legacy-subnets-v1:${value.appId}:${value.bridgeId}`
      || value.failure !== undefined) {
      throw new AppNetworkStateError(`${label} legacy provenance does not match its immutable lease`);
    }
  }
  return {
    appId: value.appId,
    bridgeId: value.bridgeId,
    bridgeName: value.bridgeName,
    cidr: cidr.cidr,
    gateway: formatIPv4(gateway),
    state: value.state as AppNetworkLeaseState,
    operationId: value.operationId,
    requiredAddresses: value.requiredAddresses,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    importedFrom,
    failure: validateFailure(value.failure, `${label}.failure`),
  };
}

export function createLegacyImportedLease(input: {
  appId: string;
  bridgeId: number;
  requiredAddresses: number;
  now?: string;
}): AppNetworkLease {
  const now = input.now ?? new Date().toISOString();
  return validateLease({
    appId: input.appId,
    bridgeId: input.bridgeId,
    bridgeName: `yeapp${input.bridgeId}`,
    cidr: `10.76.${input.bridgeId}.0/24`,
    gateway: `10.76.${input.bridgeId}.1`,
    state: 'active',
    operationId: `legacy-subnets-v1:${input.appId}:${input.bridgeId}`,
    requiredAddresses: input.requiredAddresses,
    createdAt: now,
    updatedAt: now,
    importedFrom: LEGACY_APP_NETWORK_MIGRATION_SOURCE,
  }, 0, DEFAULT_APP_NETWORK_PREFIX, [...DEFAULT_APP_NETWORK_POOLS]);
}

export function validateIpamState(value: unknown): AppNetworkIpamState {
  assertPlainObject(value, 'IPAM state');
  if (value.schema !== APP_NETWORK_IPAM_SCHEMA) {
    throw new AppNetworkStateError(`Unsupported app network IPAM schema: ${String(value.schema)}`);
  }
  assertInteger(value.allocationPrefix, 'allocationPrefix');
  if (!Array.isArray(value.pools)) throw new AppNetworkStateError('pools must be an array');
  const config = validateAppNetworkConfig({
    pools: value.pools.map((pool, index) => {
      assertString(pool, `pools[${index}]`);
      return pool;
    }),
    allocationPrefix: value.allocationPrefix,
  });
  if (!Array.isArray(value.leases)) throw new AppNetworkStateError('leases must be an array');
  const leases = value.leases.map((lease, index) => validateLease(lease, index, config.allocationPrefix, config.pools));
  assertString(value.updatedAt, 'updatedAt');

  const appIds = new Set<string>();
  const bridgeIds = new Set<number>();
  const bridgeNames = new Set<string>();
  const ranges: Array<{ appId: string; range: CidrRange }> = [];
  for (const lease of leases) {
    if (appIds.has(lease.appId)) throw new AppNetworkStateError(`Duplicate app lease: ${lease.appId}`);
    if (bridgeIds.has(lease.bridgeId)) throw new AppNetworkStateError(`Duplicate bridge ID: ${lease.bridgeId}`);
    if (bridgeNames.has(lease.bridgeName)) throw new AppNetworkStateError(`Duplicate bridge name: ${lease.bridgeName}`);
    ranges.push({ appId: lease.appId, range: parseCIDR(lease.cidr) });
    appIds.add(lease.appId);
    bridgeIds.add(lease.bridgeId);
    bridgeNames.add(lease.bridgeName);
  }
  ranges.sort((left, right) => left.range.network - right.range.network);
  for (let index = 1; index < ranges.length; index++) {
    const previous = ranges[index - 1];
    const current = ranges[index];
    if (current.range.network <= previous.range.broadcast) {
      throw new AppNetworkStateError(
        `Overlapping live leases: ${previous.appId} (${previous.range.cidr}) and ${current.appId} (${current.range.cidr})`,
      );
    }
  }

  return {
    schema: APP_NETWORK_IPAM_SCHEMA,
    allocationPrefix: config.allocationPrefix,
    pools: config.pools,
    leases,
    updatedAt: value.updatedAt,
  };
}

export function createEmptyIpamState(config: AppNetworkConfig, now = new Date().toISOString()): AppNetworkIpamState {
  const valid = validateAppNetworkConfig(config);
  return {
    schema: APP_NETWORK_IPAM_SCHEMA,
    allocationPrefix: valid.allocationPrefix,
    pools: valid.pools,
    leases: [],
    updatedAt: now,
  };
}

export function reconcileConfiguredPools(state: AppNetworkIpamState, config: AppNetworkConfig): AppNetworkIpamState {
  const current = validateIpamState(state);
  const desired = validateAppNetworkConfig(config);
  if (current.allocationPrefix !== desired.allocationPrefix && current.leases.length > 0) {
    throw new AppNetworkStateError('Cannot change the app network allocation prefix while leases exist');
  }
  for (const lease of current.leases) {
    if (!desired.pools.some((pool) => cidrContains(pool, lease.cidr))) {
      throw new AppNetworkStateError(`Configured pools would strand live lease ${lease.appId} (${lease.cidr})`);
    }
  }
  current.allocationPrefix = desired.allocationPrefix;
  current.pools = desired.pools;
  return current;
}

function nextBridgeId(state: AppNetworkIpamState, observedBridgeNames: Set<string>): number {
  const used = new Set(state.leases.map((lease) => lease.bridgeId));
  for (let bridgeId = 1; bridgeId <= 9_999_999; bridgeId++) {
    if (!used.has(bridgeId) && !observedBridgeNames.has(`yeapp${bridgeId}`)) return bridgeId;
  }
  throw new AppNetworkCapacityError('Bridge identity exhaustion: no safe yeapp<N> identity remains');
}

function nextLeaseCIDR(state: AppNetworkIpamState, excludedCIDRs: string[]): string {
  const occupied = [...state.leases.map((lease) => lease.cidr), ...excludedCIDRs]
    .map((cidr) => parseCIDR(cidr))
    .sort((left, right) => left.network - right.network);
  for (const poolCIDR of state.pools) {
    const pool = parseCIDR(poolCIDR);
    const subnetSize = 2 ** (32 - state.allocationPrefix);
    let network = pool.network;
    let occupiedIndex = 0;
    while (network + subnetSize - 1 <= pool.broadcast) {
      while (occupiedIndex < occupied.length && occupied[occupiedIndex].broadcast < network) occupiedIndex++;
      const candidateBroadcast = network + subnetSize - 1;
      const collision = occupied[occupiedIndex];
      if (!collision || collision.network > candidateBroadcast) {
        return `${formatIPv4(network >>> 0)}/${state.allocationPrefix}`;
      }
      const afterCollision = collision.broadcast + 1;
      network = Math.ceil((afterCollision - pool.network) / subnetSize) * subnetSize + pool.network;
      if (network > 0xffffffff) break;
    }
  }
  throw new AppNetworkCapacityError(
    `App network capacity exhausted across ${state.pools.join(', ')}; add a non-overlapping pool before retrying`,
  );
}

export function reserveLease(
  state: AppNetworkIpamState,
  input: {
    appId: string;
    operationId: string;
    requiredAddresses: number;
    observedBridgeNames?: Iterable<string>;
    excludedCIDRs?: string[];
    now?: string;
  },
): AppNetworkLease {
  // Durable callers validate the complete state on read and again before the
  // atomic write. Keeping this pure mutation linear is important for the
  // 2,048+ lease scale gate and the 5,000-cycle qualification.
  const valid = state;
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(input.appId)) {
    throw new AppNetworkStateError(`Invalid app ID: ${input.appId}`);
  }
  assertString(input.operationId, 'operationId');
  if (!Number.isInteger(input.requiredAddresses) || input.requiredAddresses < 1) {
    throw new AppNetworkStateError('requiredAddresses must be a positive integer');
  }
  const maximumCapacity = 2 ** (32 - valid.allocationPrefix) - 2;
  if (input.requiredAddresses > maximumCapacity) {
    throw new AppNetworkCapacityError(
      `App ${input.appId} requires ${input.requiredAddresses} addresses, but /${valid.allocationPrefix} provides ${maximumCapacity} usable addresses`,
    );
  }
  const existing = valid.leases.find((lease) => lease.appId === input.appId);
  if (existing) {
    if (existing.state === 'reserved' && existing.operationId === input.operationId) {
      return existing;
    }
    throw new AppNetworkOperationConflictError(
      existing.state === 'cleanup_pending'
        ? `App ${input.appId} has cleanup pending for ${existing.bridgeName} (${existing.cidr}); repair it before retrying`
        : `App ${input.appId} already owns ${existing.bridgeName} (${existing.cidr}) in ${existing.state} state`,
    );
  }

  const observedBridgeNames = new Set(input.observedBridgeNames ?? []);
  const bridgeId = nextBridgeId(valid, observedBridgeNames);
  const cidr = nextLeaseCIDR(valid, input.excludedCIDRs ?? []);
  const now = input.now ?? new Date().toISOString();
  const lease: AppNetworkLease = {
    appId: input.appId,
    bridgeId,
    bridgeName: `yeapp${bridgeId}`,
    cidr,
    gateway: firstHost(cidr),
    state: 'reserved',
    operationId: input.operationId,
    requiredAddresses: input.requiredAddresses,
    createdAt: now,
    updatedAt: now,
  };
  state.leases.push(lease);
  state.leases.sort((a, b) => a.bridgeId - b.bridgeId);
  state.updatedAt = now;
  return lease;
}

export function transitionLease(
  state: AppNetworkIpamState,
  appId: string,
  target: AppNetworkLeaseState,
  input: { operationId?: string; failure?: AppNetworkLease['failure']; now?: string } = {},
): AppNetworkLease {
  const lease = state.leases.find((candidate) => candidate.appId === appId);
  if (!lease) throw new AppNetworkStateError(`No app network lease exists for ${appId}`);
  const allowed: Record<AppNetworkLeaseState, AppNetworkLeaseState[]> = {
    reserved: ['reserved', 'active', 'cleanup_pending'],
    active: ['active', 'cleanup_pending'],
    cleanup_pending: ['cleanup_pending'],
  };
  if (!allowed[lease.state].includes(target)) {
    throw new AppNetworkStateError(`Invalid lease transition for ${appId}: ${lease.state} -> ${target}`);
  }
  lease.state = target;
  lease.operationId = input.operationId ?? lease.operationId;
  lease.failure = input.failure;
  lease.updatedAt = input.now ?? new Date().toISOString();
  state.updatedAt = lease.updatedAt;
  return lease;
}

export function releaseLease(state: AppNetworkIpamState, appId: string, now = new Date().toISOString()): boolean {
  const index = state.leases.findIndex((lease) => lease.appId === appId);
  if (index < 0) return false;
  state.leases.splice(index, 1);
  state.updatedAt = now;
  return true;
}

export interface AppNetworkStoreOptions {
  statePath?: string;
  allowInitialize?: boolean;
  config?: AppNetworkConfig;
}

function statePath(options?: AppNetworkStoreOptions): string {
  return options?.statePath ?? process.env.YOUEYE_APP_NETWORK_STATE_PATH ?? DEFAULT_APP_NETWORK_STATE_PATH;
}

async function fsyncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function writeIpamStateAtomic(state: AppNetworkIpamState, outputPath = statePath()): Promise<void> {
  const valid = validateIpamState(state);
  const directory = path.dirname(outputPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const tempPath = path.join(directory, `.${path.basename(outputPath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    const handle = await open(tempPath, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(valid, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(tempPath, 0o600);
    await rename(tempPath, outputPath);
    await chmod(outputPath, 0o600);
    await fsyncDirectory(directory);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function readIpamState(options: AppNetworkStoreOptions = {}): Promise<AppNetworkIpamState> {
  const inputPath = statePath(options);
  try {
    const [inputStat, directoryStat] = await Promise.all([
      stat(inputPath),
      stat(path.dirname(inputPath)),
    ]);
    if (!inputStat.isFile() || (inputStat.mode & 0o077) !== 0) {
      throw new AppNetworkStateError('App network IPAM store must be a regular file with mode 0600');
    }
    if (!directoryStat.isDirectory() || (directoryStat.mode & 0o077) !== 0) {
      throw new AppNetworkStateError('App network state directory must have mode 0700');
    }
    const raw = await readFile(inputPath, 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new AppNetworkStateError('App network IPAM store is corrupt or truncated');
    }
    const state = validateIpamState(parsed);
    return options.config ? reconcileConfiguredPools(state, options.config) : state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      if (!options.allowInitialize) {
        throw new AppNetworkStateError('App network IPAM store is missing; reconciliation is required before installation');
      }
      return createEmptyIpamState(options.config ?? {
        pools: [...DEFAULT_APP_NETWORK_POOLS],
        allocationPrefix: DEFAULT_APP_NETWORK_PREFIX,
      });
    }
    throw error;
  }
}

interface LockOwner {
  pid: number;
  operation: string;
  startedAt: string;
  bootId: string;
  processStartTime: string;
}

async function processIdentity(pid: number): Promise<{ bootId: string; processStartTime: string } | null> {
  try {
    const [bootId, processStat] = await Promise.all([
      readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
      readFile(`/proc/${pid}/stat`, 'utf8'),
    ]);
    const closingParen = processStat.lastIndexOf(')');
    const fieldsAfterCommand = processStat.slice(closingParen + 2).trim().split(/\s+/);
    const processStartTime = fieldsAfterCommand[19]; // proc(5) field 22; array begins at field 3.
    if (!processStartTime) return null;
    return { bootId: bootId.trim(), processStartTime };
  } catch {
    return null;
  }
}

async function readLockOwner(lockPath: string): Promise<LockOwner | null> {
  try {
    const raw = await readFile(path.join(lockPath, 'owner.json'), 'utf8');
    const parsed = JSON.parse(raw) as Partial<LockOwner>;
    if (Number.isInteger(parsed.pid)
      && typeof parsed.operation === 'string'
      && typeof parsed.startedAt === 'string'
      && typeof parsed.bootId === 'string'
      && typeof parsed.processStartTime === 'string') {
      return parsed as LockOwner;
    }
  } catch {
    // An incomplete owner record is handled by conservative staleness checks.
  }
  return null;
}

async function ownerIsAlive(owner: LockOwner): Promise<boolean> {
  const identity = await processIdentity(owner.pid);
  return identity?.bootId === owner.bootId && identity.processStartTime === owner.processStartTime;
}

async function removeStaleLock(lockPath: string, staleAfterMs: number): Promise<boolean> {
  let ageMs = 0;
  try {
    const lockStat = await stat(lockPath);
    ageMs = Date.now() - lockStat.mtimeMs;
  } catch {
    return true;
  }
  const owner = await readLockOwner(lockPath);
  const ownerDead = owner ? !(await ownerIsAlive(owner)) : false;
  if (owner && !ownerDead) return false;
  if (!owner && ageMs < staleAfterMs) return false;
  const stalePath = `${lockPath}.stale.${process.pid}.${randomUUID()}`;
  try {
    await rename(lockPath, stalePath);
  } catch {
    return false;
  }
  await rm(stalePath, { recursive: true, force: true });
  return true;
}

async function acquireDirectoryLock(input: {
  lockPath: string;
  operation: string;
  waitMs: number;
  staleAfterMs?: number;
}): Promise<() => Promise<void>> {
  const started = Date.now();
  const staleAfterMs = input.staleAfterMs ?? 30 * 60_000;
  const lockParent = path.dirname(input.lockPath);
  await mkdir(lockParent, { recursive: true, mode: 0o700 });
  await chmod(lockParent, 0o700);
  while (true) {
    try {
      await mkdir(input.lockPath, { mode: 0o700 });
      const identity = await processIdentity(process.pid);
      if (!identity) {
        await rm(input.lockPath, { recursive: true, force: true });
        throw new AppNetworkStateError('Cannot establish app network lock process identity');
      }
      const owner: LockOwner = {
        pid: process.pid,
        operation: input.operation,
        startedAt: new Date().toISOString(),
        ...identity,
      };
      const handle = await open(path.join(input.lockPath, 'owner.json'), 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(owner)}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      return async () => {
        await rm(input.lockPath, { recursive: true, force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (await removeStaleLock(input.lockPath, staleAfterMs)) continue;
      if (Date.now() - started >= input.waitMs) {
        const owner = await readLockOwner(input.lockPath);
        const detail = owner ? ` by pid ${owner.pid} (${owner.operation})` : '';
        throw new AppNetworkOperationConflictError(`App network operation is already in progress${detail}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

export async function mutateIpamState<T>(
  options: AppNetworkStoreOptions,
  mutation: (state: AppNetworkIpamState) => T | Promise<T>,
): Promise<T> {
  const outputPath = statePath(options);
  const release = await acquireDirectoryLock({
    lockPath: `${outputPath}.lock`,
    operation: 'allocator',
    waitMs: 30_000,
  });
  try {
    const state = await readIpamState(options);
    const result = await mutation(state);
    await writeIpamStateAtomic(state, outputPath);
    return result;
  } finally {
    await release();
  }
}

export async function withAppNetworkOperationLock<T>(
  appId: string,
  operation: string,
  work: () => Promise<T>,
  options: { stateDirectory?: string; waitMs?: number } = {},
): Promise<T> {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(appId)) {
    throw new AppNetworkStateError(`Invalid app ID: ${appId}`);
  }
  const directory = options.stateDirectory
    ?? path.dirname(process.env.YOUEYE_APP_NETWORK_STATE_PATH ?? DEFAULT_APP_NETWORK_STATE_PATH);
  const release = await acquireDirectoryLock({
    lockPath: path.join(directory, 'locks', `app-${appId}.lock`),
    operation,
    waitMs: options.waitMs ?? 0,
  });
  try {
    return await work();
  } finally {
    await release();
  }
}
