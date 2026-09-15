/**
 * Per-App Bridge Network Manager
 *
 * Each app gets its own Incus bridge with an opaque yeapp<N> identity and a
 * reusable /27 lease. Direct routing to every other configured application
 * pool is rejected on the primary NIC. Explicit integrations use a separately
 * filtered secondary NIC on the target bridge.
 *
 * System services (postgres, UI API) are exposed to app containers
 * via Incus proxy devices at localhost:{port} — no shared bridge needed.
 *
 * Caddy joins every app bridge (Docker/Traefik model) so reverse proxy routes
 * keep working with DNS names.
 *
 * DNS: bridge dnsmasq → pihole (via raw.dnsmasq server= directive) → LAN DNS.
 */

import { incusRequest, execShell } from './server';
import { getContainerIP } from './container-ip';
import { getSystemStaticIP } from './static-ips';
import { readFile } from 'fs/promises';
import { randomUUID } from 'crypto';
import { parse as parseYaml } from 'yaml';
import { assertNoCriticalIssues, observeIssue, resolveIssue } from '@/lib/health/issues';
import { spineClient } from '@/lib/spine/client';
import {
  applyIncusDeviceMergePatch,
  type IncusDeviceMap,
  type IncusDeviceMergePatch,
} from './device-merge-patch';
import {
  APP_NETWORK_IPAM_SCHEMA,
  APP_NETWORK_POOL_CANDIDATES,
  DEFAULT_APP_NETWORK_POOLS,
  DEFAULT_APP_NETWORK_PREFIX,
  AppNetworkOperationConflictError,
  AppNetworkCapacityError,
  AppNetworkStateError,
  cidrComplement,
  cidrContains,
  cidrOverlaps,
  cidrUsableAddresses,
  createLegacyImportedLease,
  formatIPv4,
  mutateIpamState,
  parseCIDR,
  parseIPv4,
  parseProcNetRoute,
  readIpamState,
  releaseLease,
  reserveLease,
  selectAppNetworkPools,
  transitionLease,
  validateAppNetworkConfig,
  withAppNetworkOperationLock,
  writeIpamStateAtomic,
  type AppNetworkConfig,
  type AppNetworkIpamState,
  type AppNetworkLease,
} from './app-network-ipam';
import {
  assertLegacyNetworkCandidate,
  readLegacySubnetRegistry,
} from './app-network-legacy-migration';

// ─── Constants ──────────────────────────────────────────────

/**
 * Bridge naming: `yeapp{N}` where N is the lowest free opaque bridge ID.
 * Linux network interface names are limited to 15 characters.
 * `ye-appnet-{appId}` would exceed this for most app IDs.
 * The IPAM store maps app ID, bridge ID, and CIDR independently.
 * The bridge description stores the appId for human readability.
 */
const BRIDGE_PREFIX = 'yeapp';

const NETWORK_CONFIG_PATH = '/var/lib/youeye/config/youeye.yaml';
const NETWORK_ISSUE_PREFIX = 'market.app-network';
const OWNERSHIP_KIND_KEY = 'user.youeye.kind';
const OWNERSHIP_APP_KEY = 'user.youeye.app_id';
const OWNERSHIP_CIDR_KEY = 'user.youeye.cidr';
const OWNERSHIP_OPERATION_KEY = 'user.youeye.operation_id';
const OWNERSHIP_KIND = 'app-network';
const NETWORK_OBJECT_TIMEOUT_MS = 120_000;
const NETWORK_INVENTORY_CONCURRENCY = 16;

/** System containers that live on incusbr0 (never moved to per-app bridges) */
const SYSTEM_CONTAINERS = [
  'youeye-control', 'youeye-ui', 'youeye-caddy',
  'youeye-postgres',
  'youeye-pihole',
  'youeye-pointer',
];

interface IncusNetwork {
  name: string;
  description?: string;
  type?: string;
  managed?: boolean;
  config?: Record<string, string>;
  used_by?: string[];
}

interface IncusInstanceWritable {
  architecture: string;
  config: Record<string, string>;
  description: string;
  devices: IncusDeviceMap;
  ephemeral: boolean;
  profiles: string[];
  stateful: boolean;
}

async function applyInstanceDeviceMergePatch(
  instance: string,
  metadata: IncusInstanceWritable,
  devicePatch: IncusDeviceMergePatch,
  operation: string,
): Promise<void> {
  // Incus 7.2's instance PATCH decoder cannot preserve nested nulls. Apply the
  // RFC 7396 device patch locally and submit only InstancePut's writable fields.
  const updated = await incusRequest('PUT', `/1.0/instances/${instance}`, {
    architecture: metadata.architecture,
    config: metadata.config,
    description: metadata.description,
    devices: applyIncusDeviceMergePatch(metadata.devices, devicePatch),
    ephemeral: metadata.ephemeral,
    profiles: metadata.profiles,
    stateful: metadata.stateful,
  });
  await waitForIncusOperation(updated, operation);
}

function assertIncusSuccess<T>(
  response: Awaited<ReturnType<typeof incusRequest<T>>>,
  operation: string,
): T {
  if (response.type === 'error' || response.status_code >= 400) {
    throw new Error(`${operation} failed: ${response.error || response.status || `HTTP ${response.status_code}`}`);
  }
  return response.metadata;
}

function safeNetworkFailure(error: unknown): string {
  if (error instanceof AppNetworkStateError || error instanceof AppNetworkOperationConflictError) {
    return error.message;
  }
  return 'Incus network operation or exact read-back failed';
}

async function waitForIncusOperation(
  response: Awaited<ReturnType<typeof incusRequest>>,
  operation: string,
  timeoutSeconds = 60,
): Promise<void> {
  if (response.type === 'error' || response.status_code >= 400) {
    throw new Error(`${operation} failed: ${response.error || response.status}`);
  }
  if (response.type === 'async' && response.operation) {
    const waited = await incusRequest(
      'GET',
      `${response.operation}/wait?timeout=${timeoutSeconds}`,
      undefined,
      { timeout: (timeoutSeconds + 10) * 1000 },
    );
    assertIncusSuccess(waited, `${operation} wait`);
  }
}

let testNetworkSnapshot: { expiresAt: number; networks: IncusNetwork[] } | null = null;
let testNetworkSnapshotRequest: Promise<IncusNetwork[]> | null = null;

async function fetchIncusNetworks(): Promise<IncusNetwork[]> {
  // Incus builds a recursive network response before sending any bytes. At
  // bridge-per-app scale that creates a single long, silent socket interval
  // even though the daemon and exact object reads remain healthy. Inventory
  // names first, then retain the same fail-closed ownership/CIDR checks by
  // reading every object with bounded concurrency.
  const inventory = await incusRequest<string[]>(
    'GET',
    '/1.0/networks',
    undefined,
    { timeout: 120_000 },
  );
  const urls = assertIncusSuccess(inventory, 'List Incus network names') ?? [];
  const networks = new Array<IncusNetwork>(urls.length);
  let next = 0;
  await Promise.all(Array.from(
    { length: Math.min(NETWORK_INVENTORY_CONCURRENCY, urls.length) },
    async () => {
      while (next < urls.length) {
        const index = next;
        next += 1;
        const url = urls[index];
        if (!/^\/1\.0\/networks\/[^/]+$/.test(url)) {
          throw new AppNetworkStateError('Incus returned an invalid network inventory entry');
        }
        const response = await incusRequest<IncusNetwork>(
          'GET',
          url,
          undefined,
          { timeout: NETWORK_OBJECT_TIMEOUT_MS },
        );
        networks[index] = assertIncusSuccess(response, `Read Incus network ${url}`);
      }
    },
  ));
  return networks;
}

async function listIncusNetworks(): Promise<IncusNetwork[]> {
  const testTtlMs = Number(process.env.YOUEYE_TEST_NETWORK_SNAPSHOT_TTL_MS ?? 0);
  if (!Number.isInteger(testTtlMs) || testTtlMs < 0 || testTtlMs > 1_800_000) {
    throw new AppNetworkStateError('YOUEYE_TEST_NETWORK_SNAPSHOT_TTL_MS must be an integer from 0 through 1800000');
  }
  if (testTtlMs === 0) return fetchIncusNetworks();
  if (testNetworkSnapshot && testNetworkSnapshot.expiresAt > Date.now()) {
    return testNetworkSnapshot.networks;
  }
  if (!testNetworkSnapshotRequest) testNetworkSnapshotRequest = fetchIncusNetworks();
  try {
    const networks = await testNetworkSnapshotRequest;
    testNetworkSnapshot = { expiresAt: Date.now() + testTtlMs, networks };
    return networks;
  } finally {
    testNetworkSnapshotRequest = null;
  }
}

/** Force a fresh inventory only for the guarded live Session harness. */
export function clearAppNetworkTestSnapshot(): void {
  if (Number(process.env.YOUEYE_TEST_NETWORK_SNAPSHOT_TTL_MS ?? 0) === 0) {
    throw new AppNetworkStateError('App network test snapshot caching is not enabled');
  }
  if (testNetworkSnapshotRequest) {
    throw new AppNetworkStateError('Cannot clear an in-flight app network test snapshot');
  }
  testNetworkSnapshot = null;
}

function networkCIDR(network: IncusNetwork): string | null {
  const address = network.config?.['ipv4.address'];
  if (!address || address === 'none' || !address.includes('/')) return null;
  try {
    const [gateway, prefix] = address.split('/');
    const prefixNumber = Number(prefix);
    const size = 2 ** (32 - prefixNumber);
    const networkAddress = Math.floor(parseIPv4(gateway) / size) * size;
    return parseCIDR(`${formatIPv4(networkAddress)}/${prefixNumber}`).cidr;
  } catch {
    throw new AppNetworkStateError(`Incus network ${network.name} has invalid ipv4.address ${address}`);
  }
}

function isOwnedAppNetwork(network: IncusNetwork): boolean {
  return network.config?.[OWNERSHIP_KIND_KEY] === OWNERSHIP_KIND;
}

function assertOwnedNetworkMatchesLease(network: IncusNetwork, lease: AppNetworkLease): void {
  const config = network.config ?? {};
  const expectedAddress = `${lease.gateway}/${parseCIDR(lease.cidr).prefix}`;
  const mismatches = [
    network.name === lease.bridgeName ? null : `name=${network.name}`,
    config['ipv4.address'] === expectedAddress ? null : `ipv4.address=${config['ipv4.address'] ?? 'missing'}`,
    config[OWNERSHIP_KIND_KEY] === OWNERSHIP_KIND ? null : `${OWNERSHIP_KIND_KEY}=${config[OWNERSHIP_KIND_KEY] ?? 'missing'}`,
    config[OWNERSHIP_APP_KEY] === lease.appId ? null : `${OWNERSHIP_APP_KEY}=${config[OWNERSHIP_APP_KEY] ?? 'missing'}`,
    config[OWNERSHIP_CIDR_KEY] === lease.cidr ? null : `${OWNERSHIP_CIDR_KEY}=${config[OWNERSHIP_CIDR_KEY] ?? 'missing'}`,
    config[OWNERSHIP_OPERATION_KEY] === lease.operationId ? null : `${OWNERSHIP_OPERATION_KEY}=${config[OWNERSHIP_OPERATION_KEY] ?? 'missing'}`,
  ].filter(Boolean);
  if (mismatches.length > 0) {
    throw new AppNetworkStateError(
      `Managed bridge ${lease.bridgeName} does not match lease ${lease.appId}: ${mismatches.join(', ')}`,
    );
  }
}

interface LoadedAppNetworkConfig {
  config: AppNetworkConfig;
  explicitPools: boolean;
}

async function loadAppNetworkConfigState(): Promise<LoadedAppNetworkConfig> {
  let fileConfig: unknown = {};
  try {
    fileConfig = parseYaml(await readFile(process.env.YOUEYE_CONFIG_PATH ?? NETWORK_CONFIG_PATH, 'utf8')) ?? {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new AppNetworkStateError('Cannot read or parse app network configuration');
    }
  }
  const section = fileConfig && typeof fileConfig === 'object'
    ? (fileConfig as Record<string, unknown>).app_network
    : undefined;
  const appNetwork = section && typeof section === 'object' && !Array.isArray(section)
    ? section as Record<string, unknown>
    : {};
  const environmentPools = process.env.YOUEYE_APP_NETWORK_POOLS
    ?.split(',').map((pool) => pool.trim()).filter(Boolean);
  const environmentExcludedCIDRs = process.env.YOUEYE_APP_NETWORK_EXCLUDED_CIDRS
    ?.split(',').map((cidr) => cidr.trim()).filter(Boolean);
  const filePools = Array.isArray(appNetwork.pools) ? appNetwork.pools.map(String) : [];
  const filePoolsConfigured = filePools.length > 0;
  const pools = environmentPools?.length
    ? environmentPools
    : filePoolsConfigured
      ? filePools
      : [...DEFAULT_APP_NETWORK_POOLS];
  const configuredPrefix = process.env.YOUEYE_APP_NETWORK_PREFIX ?? appNetwork.allocation_prefix;
  return {
    config: validateAppNetworkConfig({
      pools,
      allocationPrefix: configuredPrefix === undefined ? DEFAULT_APP_NETWORK_PREFIX : Number(configuredPrefix),
      excludedCIDRs: environmentExcludedCIDRs?.length
        ? environmentExcludedCIDRs
        : Array.isArray(appNetwork.excluded_cidrs)
          ? appNetwork.excluded_cidrs.map(String)
          : [],
    }),
    explicitPools: Boolean(environmentPools?.length || filePoolsConfigured),
  };
}

async function loadAppNetworkConfig(): Promise<AppNetworkConfig> {
  return (await loadAppNetworkConfigState()).config;
}

const HOST_ROUTE_DEVICE = 'youeye-host-ipv4-routes';
const HOST_ROUTE_PATH = '/host/proc/net/route';

async function hostRouteCIDRs(): Promise<string[]> {
  // The live Session harness runs this production module on the appliance host,
  // where the same host route file is already available at /proc/net/route.
  // Deployed CP never sets this test-only override and uses the owned read-only
  // mount below.
  const routeReadPath = process.env.YOUEYE_TEST_HOST_ROUTE_PATH || HOST_ROUTE_PATH;
  const expectedDevice = {
    type: 'disk',
    source: '/proc/net/route',
    path: HOST_ROUTE_PATH,
    readonly: 'true',
  };
  const response = await incusRequest<{ devices?: Record<string, Record<string, string>> }>(
    'GET',
    '/1.0/instances/youeye-control',
  );
  const instance = assertIncusSuccess(response, 'Read Control Panel host-route view');
  const devices = { ...(instance.devices ?? {}) };
  const existing = devices[HOST_ROUTE_DEVICE];
  if (existing && Object.entries(expectedDevice).some(([key, value]) => existing[key] !== value)) {
    throw new AppNetworkStateError(`Control Panel device ${HOST_ROUTE_DEVICE} is not the owned read-only host route view`);
  }
  if (!existing) {
    devices[HOST_ROUTE_DEVICE] = expectedDevice;
    const patched = await incusRequest('PATCH', '/1.0/instances/youeye-control', { devices });
    await waitForIncusOperation(patched, 'Attach read-only host IPv4 route view');
    const readBack = await incusRequest<{ devices?: Record<string, Record<string, string>> }>(
      'GET',
      '/1.0/instances/youeye-control',
    );
    const observed = assertIncusSuccess(readBack, 'Read back Control Panel host-route view')
      .devices?.[HOST_ROUTE_DEVICE];
    if (!observed || Object.entries(expectedDevice).some(([key, value]) => observed[key] !== value)) {
      throw new AppNetworkStateError('Read-only host IPv4 route view did not read back exactly');
    }
  }
  try {
    return parseProcNetRoute(await readFile(routeReadPath, 'utf8'));
  } catch {
    throw new AppNetworkStateError('Cannot inspect host IPv4 routes');
  }
}

export interface AppNetworkBootstrapResult {
  eligible: boolean;
  changed: boolean;
  selectedPools: string[];
  reason: string;
}

interface AppNetworkBootstrapAssessment extends AppNetworkBootstrapResult {
  desiredConfig?: AppNetworkConfig;
  existingState?: AppNetworkIpamState | null;
}

function externalNetworkCIDRs(networks: IncusNetwork[], routes: string[], excludedCIDRs: string[]): string[] {
  const external = new Set<string>([...routes, ...excludedCIDRs]);
  for (const network of networks) {
    const cidr = networkCIDR(network);
    if (cidr) external.add(cidr);
  }
  return [...external].sort((left, right) => parseCIDR(left).network - parseCIDR(right).network);
}

async function assessEmptyAppNetworkBootstrap(): Promise<AppNetworkBootstrapAssessment> {
  const loaded = await loadAppNetworkConfigState();
  if (loaded.explicitPools) {
    return {
      eligible: false,
      changed: false,
      selectedPools: loaded.config.pools,
      reason: 'An administrator-selected app network pool is already authoritative',
    };
  }

  const [networks, routes, metadataModule, trackerModule] = await Promise.all([
    listIncusNetworks(),
    hostRouteCIDRs(),
    import('../market/metadata'),
    import('../market/install-tracker'),
  ]);
  if (networks.some((network) => isOwnedAppNetwork(network) || /^yeapp\d+$/.test(network.name))) {
    return {
      eligible: false,
      changed: false,
      selectedPools: loaded.config.pools,
      reason: 'An existing app bridge makes automatic pool selection unsafe',
    };
  }

  let existingState: AppNetworkIpamState | null = null;
  try {
    existingState = await readIpamState({ allowInitialize: false });
  } catch (error) {
    if (!(error instanceof AppNetworkStateError)
      || !error.message.startsWith('App network IPAM store is missing')) {
      throw error;
    }
  }
  if ((existingState?.leases.length ?? 0) > 0) {
    return {
      eligible: false,
      changed: false,
      selectedPools: loaded.config.pools,
      reason: 'Durable app network leases already exist',
    };
  }

  const [installedApps, activeInstalls] = await Promise.all([
    metadataModule.listInstalledApps(),
    Promise.resolve(trackerModule.getAllActiveInstalls()),
  ]);
  if (installedApps.length > 0 || activeInstalls.length > 0) {
    return {
      eligible: false,
      changed: false,
      selectedPools: loaded.config.pools,
      reason: 'Installed or active application state makes automatic pool selection unsafe',
    };
  }

  const selectedPools = selectAppNetworkPools(
    APP_NETWORK_POOL_CANDIDATES,
    externalNetworkCIDRs(networks, routes, loaded.config.excludedCIDRs ?? []),
  );
  return {
    eligible: true,
    changed: true,
    selectedPools,
    reason: selectedPools[0] === DEFAULT_APP_NETWORK_POOLS[0]
      ? 'The preferred app network pool is free and will be made durable'
      : `The preferred pool overlaps the host; ${selectedPools[0]} is the first safe bounded candidate`,
    desiredConfig: validateAppNetworkConfig({
      pools: selectedPools,
      allocationPrefix: loaded.config.allocationPrefix,
      excludedCIDRs: loaded.config.excludedCIDRs,
    }),
    existingState,
  };
}

/** Read-only eligibility check used to expose exactly one guarded Health repair. */
export async function canRepairEmptyAppNetworkBootstrap(): Promise<AppNetworkBootstrapResult> {
  const assessment = await assessEmptyAppNetworkBootstrap();
  const { desiredConfig: _, existingState: __, ...result } = assessment;
  void _;
  void __;
  return result;
}

/**
 * Persist a deterministic, collision-free pool before first app-network
 * reconciliation. Mutation is permitted only when every durable/runtime
 * source proves that the app-network installation is empty.
 */
export async function ensureAppNetworkBootstrapConfig(): Promise<AppNetworkBootstrapResult> {
  return withAppNetworkOperationLock('network-bootstrap', 'bootstrap-pool', async () => {
    const assessment = await assessEmptyAppNetworkBootstrap();
    if (!assessment.eligible || !assessment.desiredConfig) {
      const { desiredConfig: _, existingState: __, ...result } = assessment;
      void _;
      void __;
      return result;
    }

    const desired = assessment.desiredConfig;
    const response = await spineClient.patchConfig({
      app_network: {
        pools: desired.pools,
        allocation_prefix: desired.allocationPrefix,
        excluded_cidrs: desired.excludedCIDRs ?? [],
      },
    });
    const stored = (response.config as Record<string, unknown>).app_network;
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
      throw new AppNetworkStateError('Spine did not read back the persisted app network bootstrap plan');
    }
    const verifiedConfig = await loadAppNetworkConfig();
    if (!sameStringSet(verifiedConfig.pools, desired.pools)
      || verifiedConfig.allocationPrefix !== desired.allocationPrefix) {
      throw new AppNetworkStateError('Persisted app network bootstrap plan does not match the selected pool');
    }

    const nextState = assessment.existingState ?? {
      schema: APP_NETWORK_IPAM_SCHEMA,
      allocationPrefix: desired.allocationPrefix,
      pools: desired.pools,
      leases: [],
      updatedAt: new Date().toISOString(),
    };
    nextState.pools = desired.pools;
    nextState.allocationPrefix = desired.allocationPrefix;
    nextState.updatedAt = new Date().toISOString();
    await writeIpamStateAtomic(nextState);
    await observeAppNetworkState();

    return {
      eligible: true,
      changed: true,
      selectedPools: desired.pools,
      reason: assessment.reason,
    };
  });
}

export async function repairEmptyAppNetworkBootstrap(): Promise<AppNetworkBootstrapResult> {
  return ensureAppNetworkBootstrapConfig();
}

function sameStringSet(left: Iterable<string>, right: Iterable<string>): boolean {
  const a = [...left].sort();
  const b = [...right].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sameLegacyLease(left: AppNetworkLease, right: AppNetworkLease): boolean {
  return left.appId === right.appId
    && left.bridgeId === right.bridgeId
    && left.bridgeName === right.bridgeName
    && left.cidr === right.cidr
    && left.gateway === right.gateway
    && left.state === right.state
    && left.operationId === right.operationId
    && left.requiredAddresses === right.requiredAddresses
    && left.importedFrom === right.importedFrom
    && left.failure === undefined;
}

/**
 * Import only the exact retired allocator state already proved by the legacy
 * registry, install metadata, Incus attachments, Caddy devices, and bridge
 * configuration. The complete lease map is durable before ownership metadata
 * is added, so an interruption remains fail-closed and a later reconcile can
 * resume without adopting any unfamiliar object.
 */
async function migrateLegacyAppNetworks(input: {
  config: AppNetworkConfig;
  networks: IncusNetwork[];
  routes: string[];
}): Promise<IncusNetwork[]> {
  const legacyNamed = input.networks.filter((network) => /^yeapp\d+$/.test(network.name));
  if (legacyNamed.every(isOwnedAppNetwork)) return input.networks;

  const registry = await readLegacySubnetRegistry();
  const allocations = Object.entries(registry.allocated)
    .map(([appId, bridgeId]) => ({ appId, bridgeId }))
    .sort((left, right) => left.bridgeId - right.bridgeId);
  if (!sameStringSet(legacyNamed.map((network) => network.name), allocations.map(({ bridgeId }) => `yeapp${bridgeId}`))) {
    throw new AppNetworkStateError(
      'Legacy app network registry and Incus yeapp<N> inventory differ; refusing automatic adoption',
    );
  }

  const [{ listInstalledApps }, piholeIP] = await Promise.all([
    import('../market/metadata'),
    getSystemStaticIP('youeye-pihole'),
  ]);
  if (!piholeIP) throw new AppNetworkStateError('Legacy app network migration cannot prove the Pi-hole address');
  const installed = await listInstalledApps();
  if (!sameStringSet(installed.map((metadata) => metadata.appId), allocations.map(({ appId }) => appId))) {
    throw new AppNetworkStateError(
      'Legacy app network registry and installed application metadata differ; refusing automatic adoption',
    );
  }
  const metadataByApp = new Map(installed.map((metadata) => [metadata.appId, metadata]));
  const caddyResponse = await incusRequest<IncusInstanceWritable>('GET', '/1.0/instances/youeye-caddy');
  const caddy = { name: 'youeye-caddy', ...assertIncusSuccess(caddyResponse, 'Read Caddy legacy network attachments') };
  const now = new Date().toISOString();
  const leases: AppNetworkLease[] = [];

  for (const { appId, bridgeId } of allocations) {
    const metadata = metadataByApp.get(appId);
    if (!metadata || metadata.lifecycleState === 'installing') {
      throw new AppNetworkStateError(`Legacy app network migration cannot prove active metadata for ${appId}`);
    }
    const containerNames = (metadata.containers ?? [])
      .map((container) => typeof container === 'string' ? container : container.containerName)
      .filter((name): name is string => Boolean(name));
    const network = legacyNamed.find((candidate) => candidate.name === `yeapp${bridgeId}`);
    if (!network) throw new AppNetworkStateError(`Legacy app network ${appId} bridge is absent`);
    const instances = await Promise.all(containerNames.map(async (name) => {
      const response = await incusRequest<IncusInstanceWritable>('GET', `/1.0/instances/${name}`);
      return { name, ...assertIncusSuccess(response, `Read ${appId} legacy network attachment`) };
    }));
    assertLegacyNetworkCandidate({ appId, bridgeId, network, containerNames, instances, caddy, piholeIP });
    leases.push(createLegacyImportedLease({
      appId,
      bridgeId,
      requiredAddresses: containerNames.length + 1,
      now,
    }));
  }

  const allowedCIDRs = new Set(leases.map((lease) => lease.cidr));
  for (const network of input.networks) {
    const cidr = networkCIDR(network);
    if (cidr && input.config.pools.some((pool) => cidrOverlaps(pool, cidr)) && !allowedCIDRs.has(cidr)) {
      throw new AppNetworkStateError(
        `Legacy app network pool overlaps unfamiliar Incus network ${network.name} (${cidr}); refusing automatic adoption`,
      );
    }
  }
  for (const route of input.routes) {
    if (input.config.pools.some((pool) => cidrOverlaps(pool, route)) && !allowedCIDRs.has(route)) {
      throw new AppNetworkStateError(
        `Legacy app network pool overlaps unfamiliar host route ${route}; refusing automatic adoption`,
      );
    }
  }

  const durableLeases = await mutateIpamState({ config: input.config, allowInitialize: true }, (state) => {
    for (const existing of state.leases) {
      const expected = leases.find((lease) => lease.appId === existing.appId);
      if (!expected || !sameLegacyLease(existing, expected)) {
        throw new AppNetworkStateError('Existing app network IPAM state differs from the proved legacy allocation');
      }
    }
    for (const expected of leases) {
      const existing = state.leases.find((lease) => lease.appId === expected.appId);
      if (!existing) state.leases.push(expected);
    }
    state.leases.sort((left, right) => left.bridgeId - right.bridgeId);
    state.updatedAt = now;
    return state.leases.map((lease) => structuredClone(lease));
  });

  const migrated = new Map(input.networks.map((network) => [network.name, network]));
  for (const lease of durableLeases) {
    const before = migrated.get(lease.bridgeName);
    if (!before) throw new AppNetworkStateError(`Proved legacy bridge ${lease.bridgeName} disappeared`);
    if (!isOwnedAppNetwork(before)) {
      const updated = await incusRequest('PATCH', `/1.0/networks/${lease.bridgeName}`, {
        config: {
          [OWNERSHIP_KIND_KEY]: OWNERSHIP_KIND,
          [OWNERSHIP_APP_KEY]: lease.appId,
          [OWNERSHIP_CIDR_KEY]: lease.cidr,
          [OWNERSHIP_OPERATION_KEY]: lease.operationId,
        },
      }, { timeout: NETWORK_OBJECT_TIMEOUT_MS });
      await waitForIncusOperation(updated, `Annotate proved legacy app bridge ${lease.bridgeName}`);
    }
    const readBack = await incusRequest<IncusNetwork>(
      'GET',
      `/1.0/networks/${lease.bridgeName}`,
      undefined,
      { timeout: NETWORK_OBJECT_TIMEOUT_MS },
    );
    const network = assertIncusSuccess(readBack, `Read back migrated legacy bridge ${lease.bridgeName}`);
    assertOwnedNetworkMatchesLease(network, lease);
    migrated.set(lease.bridgeName, network);
  }
  return input.networks.map((network) => migrated.get(network.name) ?? network);
}

interface AppNetworkObservation {
  config: AppNetworkConfig;
  state: AppNetworkIpamState;
  networks: IncusNetwork[];
  externalCIDRs: string[];
}

async function observeAppNetworkState(): Promise<AppNetworkObservation> {
  const [config, initialNetworks, routes] = await Promise.all([
    loadAppNetworkConfig(),
    listIncusNetworks(),
    hostRouteCIDRs(),
  ]);
  const networks = await migrateLegacyAppNetworks({ config, networks: initialNetworks, routes });
  const managed = networks.filter(isOwnedAppNetwork);
  const state = await readIpamState({
    config,
    allowInitialize: managed.length === 0,
  });
  const leasesByBridge = new Map(state.leases.map((lease) => [lease.bridgeName, lease]));

  for (const network of managed) {
    const lease = leasesByBridge.get(network.name);
    if (!lease) {
      throw new AppNetworkStateError(
        `Managed Incus bridge ${network.name} has no durable ${APP_NETWORK_IPAM_SCHEMA} lease; refusing automatic adoption`,
      );
    }
    assertOwnedNetworkMatchesLease(network, lease);
  }
  for (const network of networks) {
    if (/^yeapp\d+$/.test(network.name) && !isOwnedAppNetwork(network)) {
      throw new AppNetworkStateError(
        `Unowned Incus network name collision ${network.name}; remove or rename it explicitly before app network allocation`,
      );
    }
  }

  const externalCIDRs = new Set<string>();
  for (const network of networks) {
    const cidr = networkCIDR(network);
    if (!cidr) continue;
    const matchingLease = leasesByBridge.get(network.name);
    if (matchingLease && isOwnedAppNetwork(network) && matchingLease.cidr === cidr) continue;
    externalCIDRs.add(cidr);
  }
  for (const route of routes) {
    if (state.leases.some((lease) => lease.cidr === route)) continue;
    externalCIDRs.add(route);
  }
  for (const excludedCIDR of config.excludedCIDRs ?? []) externalCIDRs.add(excludedCIDR);
  for (const pool of config.pools) {
    const overlap = [...externalCIDRs].find((cidr) => cidrOverlaps(pool, cidr));
    if (overlap) {
      throw new AppNetworkStateError(
        `Configured app network pool ${pool} overlaps current route or Incus network ${overlap}`,
      );
    }
  }
  return { config, state, networks, externalCIDRs: [...externalCIDRs] };
}

// ─── Bridge Name Helpers ────────────────────────────────────

/**
 * Get the Incus bridge name for an app.
 * Uses the opaque bridge ID from the IPAM store: `yeapp{N}`.
 * Returns null if the app has no allocated subnet.
 */
export async function getAppBridgeName(appId: string): Promise<string | null> {
  const observation = await observeAppNetworkState();
  return observation.state.leases.find((lease) => lease.appId === appId)?.bridgeName ?? null;
}

export async function getAppBridgeGatewayIP(appId: string): Promise<string | null> {
  const bridgeName = await getAppBridgeName(appId);
  if (!bridgeName) return null;

  const res = await incusRequest<{ config?: Record<string, string> }>('GET', `/1.0/networks/${bridgeName}`);
  const address = assertIncusSuccess(res, `Read app bridge ${bridgeName}`).config?.['ipv4.address'];
  if (!address || address === 'none') return null;
  return address.split('/')[0] || null;
}

/** Check if a bridge exists. */
async function bridgeExists(name: string): Promise<boolean> {
  const res = await incusRequest('GET', `/1.0/networks/${name}`, undefined, { timeout: NETWORK_OBJECT_TIMEOUT_MS });
  if (res.type === 'error' || res.status_code >= 400) {
    if (res.error_code === 404 || res.status_code === 404) return false;
    throw new Error(`Observe Incus bridge ${name} failed: ${res.error || res.status}`);
  }
  return true;
}

// ─── Core Bridge Operations ─────────────────────────────────

/**
 * Create a per-app bridge network.
 *
 * Creates an Incus managed bridge with:
 * - Unique /27 subnet from one or more configured private pools
 * - DNS domain "youeye" (same as incusbr0 — container names are globally unique)
 * - DNS forwarding to pihole via raw.dnsmasq
 * - Optional NAT for internet access
 */
export async function createAppNetwork(
  appId: string,
  options: { nat?: boolean; operationId?: string; requiredAddresses?: number } = {},
): Promise<{ bridgeName: string; subnet: number; subnetCIDR: string }> {
  await assertNoCriticalIssues(`Install ${appId}`);
  const observation = await observeAppNetworkState();

  // Use static IP for pihole DNS forwarding (deterministic, survives restarts)
  const piholeIP = await getSystemStaticIP('youeye-pihole') || await getContainerIP('youeye-pihole');
  if (!piholeIP) {
    throw new Error(
      'Cannot create app network: Pi-Hole IP was not found, so app DNS forwarding cannot be configured'
    );
  }

  const operationId = options.operationId ?? `app-network-${appId}-${randomUUID()}`;
  const requiredAddresses = options.requiredAddresses ?? 8;
  const observedBridgeNames = observation.networks.map((network) => network.name);
  const lease = await mutateIpamState(
    { config: observation.config, allowInitialize: observation.state.leases.length === 0 },
    (state) => reserveLease(state, {
      appId,
      operationId,
      requiredAddresses,
      observedBridgeNames,
      excludedCIDRs: observation.externalCIDRs,
    }),
  );
  const prefix = parseCIDR(lease.cidr).prefix;
  const gatewayIP = `${lease.gateway}/${prefix}`;

  const config: Record<string, string> = {
    'ipv4.address': gatewayIP,
    'ipv4.dhcp': 'true',
    'ipv4.nat': options.nat ? 'true' : 'false',
    'ipv6.address': 'none',
    'dns.domain': 'youeye',
    [OWNERSHIP_KIND_KEY]: OWNERSHIP_KIND,
    [OWNERSHIP_APP_KEY]: appId,
    [OWNERSHIP_CIDR_KEY]: lease.cidr,
    [OWNERSHIP_OPERATION_KEY]: lease.operationId,
  };

  // Forward unresolved DNS queries to Pi-Hole. This is a hard invariant for
  // app networks so per-app DNS policy and local rewrites are always applied.
  config['raw.dnsmasq'] = `server=${piholeIP}`;

  try {
    if (!(await bridgeExists(lease.bridgeName))) {
      const created = await incusRequest('POST', '/1.0/networks', {
        name: lease.bridgeName,
        description: `YouEye app network: ${appId}`,
        type: 'bridge',
        config,
      }, { timeout: 180_000 });
      await waitForIncusOperation(created, `Create app bridge ${lease.bridgeName}`, 300);
    }
    const readBack = await incusRequest<IncusNetwork>(
      'GET',
      `/1.0/networks/${lease.bridgeName}`,
      undefined,
      { timeout: NETWORK_OBJECT_TIMEOUT_MS },
    );
    const network = assertIncusSuccess(readBack, `Read back app bridge ${lease.bridgeName}`);
    assertOwnedNetworkMatchesLease(network, lease);
    for (const [key, value] of Object.entries(config)) {
      if (network.config?.[key] !== value) {
        throw new AppNetworkStateError(
          `App bridge ${lease.bridgeName} read-back mismatch for ${key}: expected ${value}, got ${network.config?.[key] ?? 'missing'}`,
        );
      }
    }
    await resolveIssue(`${NETWORK_ISSUE_PREFIX}.${appId}`);
    console.log(`[app-network] Created bridge ${lease.bridgeName} (${lease.cidr}, nat=${options.nat ?? false})`);
    return { bridgeName: lease.bridgeName, subnet: lease.bridgeId, subnetCIDR: lease.cidr };
  } catch (error) {
    let retained = false;
    try {
      retained = await bridgeExists(lease.bridgeName);
    } catch {
      retained = true;
    }
    await mutateIpamState({ config: observation.config, allowInitialize: false }, (state) => {
      if (retained) {
        transitionLease(state, appId, 'cleanup_pending', {
          operationId: lease.operationId,
          failure: { stage: 'create', message: 'Bridge creation or exact read-back failed', observedAt: new Date().toISOString() },
        });
      } else {
        releaseLease(state, appId);
      }
    });
    await observeIssue({
      id: `${NETWORK_ISSUE_PREFIX}.${appId}`,
      severity: retained ? 'critical' : 'error',
      source: 'app-network',
      title: retained ? `App network cleanup required for ${appId}` : `App network creation failed for ${appId}`,
      body: retained
        ? `Bridge ${lease.bridgeName} (${lease.cidr}) may remain after a failed create and is retained as cleanup_pending.`
        : `Bridge creation failed before a network remained; the reserved lease was released safely.`,
      fixable: true,
      repairFn: 'reconcile-apps',
      learnMore: '/settings/system/health',
      debounce: 1,
    });
    throw error;
  }
}

export async function preflightAppNetwork(
  appId: string,
  options: { requiredAddresses: number },
): Promise<{ bridgeName: string; subnetCIDR: string; gateway: string }> {
  await assertNoCriticalIssues(`Install ${appId}`);
  const observation = await observeAppNetworkState();
  const existing = observation.state.leases.find((lease) => lease.appId === appId);
  if (existing) {
    throw new AppNetworkOperationConflictError(
      existing.state === 'cleanup_pending'
        ? `App ${appId} has cleanup pending for ${existing.bridgeName} (${existing.cidr}); run the supported repair before retrying`
        : `App ${appId} already owns ${existing.bridgeName} (${existing.cidr}) in ${existing.state} state`,
    );
  }
  const trial = structuredClone(observation.state);
  const lease = reserveLease(trial, {
    appId,
    operationId: `preflight-${randomUUID()}`,
    requiredAddresses: options.requiredAddresses,
    observedBridgeNames: observation.networks.map((network) => network.name),
    excludedCIDRs: observation.externalCIDRs,
  });
  return { bridgeName: lease.bridgeName, subnetCIDR: lease.cidr, gateway: lease.gateway };
}

export async function getAppNetworkLease(appId: string): Promise<AppNetworkLease | null> {
  const observation = await observeAppNetworkState();
  return observation.state.leases.find((lease) => lease.appId === appId) ?? null;
}

export async function markAppNetworkActive(appId: string): Promise<AppNetworkLease> {
  const config = await loadAppNetworkConfig();
  const state = await readIpamState({ config, allowInitialize: false });
  const lease = state.leases.find((candidate) => candidate.appId === appId);
  if (!lease) throw new AppNetworkStateError(`Cannot activate app network for ${appId}: no lease exists`);
  const response = await incusRequest<IncusNetwork>(
    'GET',
    `/1.0/networks/${lease.bridgeName}`,
    undefined,
    { timeout: NETWORK_OBJECT_TIMEOUT_MS },
  );
  const network = assertIncusSuccess(response, `Read app bridge ${lease.bridgeName} before activation`);
  assertOwnedNetworkMatchesLease(network, lease);
  return mutateIpamState({ config, allowInitialize: false }, (current) =>
    transitionLease(current, appId, 'active', { operationId: lease.operationId }),
  );
}

export async function markAppNetworkCleanupPending(
  appId: string,
  stage: string,
  error: unknown,
): Promise<AppNetworkLease | null> {
  void error;
  const config = await loadAppNetworkConfig();
  const state = await readIpamState({ config, allowInitialize: false });
  const lease = state.leases.find((candidate) => candidate.appId === appId);
  if (!lease) return null;
  const updated = await mutateIpamState({ config, allowInitialize: false }, (current) =>
    transitionLease(current, appId, 'cleanup_pending', {
      operationId: lease.operationId,
      failure: { stage, message: 'Cleanup did not reach all verified postconditions', observedAt: new Date().toISOString() },
    }),
  );
  await observeIssue({
    id: `${NETWORK_ISSUE_PREFIX}.${appId}`,
    severity: 'critical',
    source: 'app-network',
    title: `App network cleanup required for ${appId}`,
    body: `Lease ${lease.bridgeName} (${lease.cidr}) is retained cleanup_pending after ${stage}. It is not reusable until supported reconciliation verifies complete cleanup.`,
    fixable: true,
    repairFn: 'reconcile-apps',
    learnMore: '/settings/system/health',
    debounce: 1,
  });
  return updated;
}

/**
 * Delete a per-app bridge network and free its subnet.
 * Bridge must have no containers attached (delete containers first).
 */
export async function deleteAppNetwork(appId: string): Promise<void> {
  const config = await loadAppNetworkConfig();
  const state = await readIpamState({ config, allowInitialize: false });
  const lease = state.leases.find((candidate) => candidate.appId === appId);
  if (!lease) return;
  await mutateIpamState({ config, allowInitialize: false }, (current) => {
    transitionLease(current, appId, 'cleanup_pending', {
      operationId: lease.operationId,
      failure: { stage: 'delete', message: 'Network deletion in progress', observedAt: new Date().toISOString() },
    });
  });
  try {
    if (await bridgeExists(lease.bridgeName)) {
      const deleted = await incusRequest(
        'DELETE',
        `/1.0/networks/${lease.bridgeName}`,
        undefined,
        { timeout: 180_000 },
      );
      await waitForIncusOperation(deleted, `Delete app bridge ${lease.bridgeName}`, 300);
    }
    if (await bridgeExists(lease.bridgeName)) {
      throw new Error(`Incus bridge ${lease.bridgeName} still exists after delete completed`);
    }
    await mutateIpamState({ config, allowInitialize: false }, (current) => {
      releaseLease(current, appId);
    });
    await resolveIssue(`${NETWORK_ISSUE_PREFIX}.${appId}`);
    console.log(`[app-network] Deleted bridge ${lease.bridgeName} and released ${lease.cidr}`);
  } catch {
    await mutateIpamState({ config, allowInitialize: false }, (current) => {
      transitionLease(current, appId, 'cleanup_pending', {
        operationId: lease.operationId,
        failure: { stage: 'delete', message: 'Bridge absence could not be verified after deletion', observedAt: new Date().toISOString() },
      });
    });
    await observeIssue({
      id: `${NETWORK_ISSUE_PREFIX}.${appId}`,
      severity: 'critical',
      source: 'app-network',
      title: `App network cleanup required for ${appId}`,
      body: `Bridge ${lease.bridgeName} (${lease.cidr}) could not be verified absent. Its lease remains cleanup_pending and cannot be reused.`,
      fixable: true,
      repairFn: 'reconcile-apps',
      learnMore: '/settings/system/health',
      debounce: 1,
    });
    throw new Error(`App network deletion failed for ${appId}; lease retained cleanup_pending`);
  }
}

/**
 * Enable or disable NAT (internet access) on an app's bridge.
 * NAT is enabled during install so containers can pull packages/images,
 * then disabled post-install for apps that don't require blanket internet.
 */
export async function setAppNetworkNAT(appId: string, enable: boolean): Promise<void> {
  const bridgeName = await getAppBridgeName(appId);
  if (!bridgeName) throw new AppNetworkStateError(`Cannot change NAT for ${appId}: no app bridge lease exists`);
  const updated = await incusRequest('PATCH', `/1.0/networks/${bridgeName}`, {
    config: { 'ipv4.nat': enable ? 'true' : 'false' },
  });
  await waitForIncusOperation(updated, `Set NAT on ${bridgeName}`);
  const readBack = await incusRequest<IncusNetwork>('GET', `/1.0/networks/${bridgeName}`);
  const network = assertIncusSuccess(readBack, `Read back NAT on ${bridgeName}`);
  if (network.config?.['ipv4.nat'] !== (enable ? 'true' : 'false')) {
    throw new AppNetworkStateError(`NAT read-back mismatch on ${bridgeName}`);
  }
  console.log(`[app-network] NAT ${enable ? 'enabled' : 'disabled'} on ${bridgeName}`);
}

// ─── Caddy NIC Management ──────────────────────────────────

/**
 * Hot-plug a NIC onto youeye-caddy connecting it to an app bridge.
 * This is the Docker/Traefik model: the reverse proxy joins every backend network.
 */
export async function addCaddyToAppNetwork(appId: string): Promise<void> {
  const bridgeName = await getAppBridgeName(appId);
  if (!bridgeName) {
    throw new AppNetworkStateError(`No bridge found for ${appId}`);
  }

  const deviceName = `net-${appId}`;

  const res = await incusRequest<{
    devices: Record<string, Record<string, string>>;
  }>('GET', '/1.0/instances/youeye-caddy');
  const metadata = assertIncusSuccess(res, 'Read Caddy NICs');
  const devices = { ...metadata.devices };
  const ifName = `eth-${appId.substring(0, 11)}`;
  const expected = { type: 'nic', network: bridgeName, name: ifName };
  if (!devices[deviceName]) {
    devices[deviceName] = expected;
    const patched = await incusRequest('PATCH', '/1.0/instances/youeye-caddy', { devices });
    await waitForIncusOperation(patched, `Attach Caddy to ${bridgeName}`);
  }
  const readBack = await incusRequest<{ devices: Record<string, Record<string, string>> }>('GET', '/1.0/instances/youeye-caddy');
  const attached = assertIncusSuccess(readBack, 'Read back Caddy NICs').devices?.[deviceName];
  if (!attached || attached.network !== bridgeName || attached.name !== ifName) {
    throw new AppNetworkStateError(`Caddy NIC ${deviceName} did not read back on ${bridgeName}`);
  }
  console.log(`[app-network] Added Caddy NIC for ${bridgeName} (${appId})`);
}

/**
 * Remove Caddy's NIC from an app bridge.
 */
export async function removeCaddyFromAppNetwork(appId: string): Promise<void> {
  const deviceName = `net-${appId}`;

  const res = await incusRequest<IncusInstanceWritable>('GET', '/1.0/instances/youeye-caddy');
  const metadata = assertIncusSuccess(res, 'Read Caddy NICs');
  if (metadata.devices?.[deviceName]) {
    // The exact RFC 7396 intent is an explicit null for this one device.
    // Incus 7.2's typed instance PATCH cannot carry that nested null through
    // to its device merge, so apply it locally and send only InstancePut's
    // writable fields. Never echo the complete read-only instance response.
    const devicePatch: IncusDeviceMergePatch = { [deviceName]: null };
    await applyInstanceDeviceMergePatch(
      'youeye-caddy',
      metadata,
      devicePatch,
      `Remove Caddy NIC for ${appId}`,
    );
  }
  const readBack = await incusRequest<{ devices: Record<string, Record<string, string>> }>('GET', '/1.0/instances/youeye-caddy');
  if (assertIncusSuccess(readBack, 'Read back Caddy NIC removal').devices?.[deviceName]) {
    throw new AppNetworkStateError(`Caddy NIC ${deviceName} still exists after removal`);
  }
  console.log(`[app-network] Removed Caddy NIC for ${appId}`);
}

// ─── Proxy Device Management ───────────────────────────────

/** Service definitions for proxy devices */
interface ProxyService {
  name: string;
  containerName: string;
  port: number;
  /** Port to listen on inside the app container (defaults to same as service port) */
  listenPort?: number;
}

/**
 * Standard system services available via proxy devices.
 * Each proxy makes the service accessible at localhost:{port} inside the app container.
 */
export async function getSystemServices(options: {
  needsSharedDb: boolean;
  needsSSO: boolean;
  needsAI?: boolean;
}): Promise<ProxyService[]> {
  const services: ProxyService[] = [];

  // Platform UI API — all apps need this (header, notifications, settings, timeline)
  services.push({
    name: 'ui-proxy',
    containerName: 'youeye-ui',
    port: 3000,
    listenPort: 3001, // App itself runs on 3000, so UI proxy listens on 3001
  });

  // Shared PostgreSQL
  if (options.needsSharedDb) {
    services.push({
      name: 'pg-proxy',
      containerName: 'youeye-postgres',
      port: 5432,
    });
  }

  // YouEye ID SSO. Apps access the identity-owned service through a localhost
  // proxy device rather than by reaching the Control Panel dashboard port.
  if (options.needsSSO) {
    services.push({
      name: 'identity-proxy',
      containerName: 'youeye-control',
      port: 3001,
      listenPort: 3002,
    });
  }

  // Inference only. Pointer management remains unreachable from app networks.
  if (options.needsAI) {
    services.push({
      name: 'pointer-inference-proxy',
      containerName: 'youeye-pointer',
      port: 4002,
      listenPort: 3003,
    });
  }

  return services;
}

/**
 * Add proxy devices to a container for system services.
 * Each proxy makes a system service accessible at localhost:{port} inside the container.
 *
 * Proxy devices are Incus-managed userspace TCP proxies. The proxy runs on the HOST
 * (which can reach both incusbr0 and the app bridge), so the app container doesn't
 * need any NIC on incusbr0.
 *
 * Performance: <1ms latency per connection. Fine for web apps.
 */
export async function addProxyDevices(
  containerName: string,
  services: ProxyService[],
): Promise<void> {
  if (services.length === 0) return;

  const res = await incusRequest<{
    devices: Record<string, Record<string, string>>;
  }>('GET', `/1.0/instances/${containerName}`);
  const metadata = assertIncusSuccess(res, `Read proxy target ${containerName}`);
  const devices = { ...metadata.devices };
  const expected: Record<string, Record<string, string>> = {};

  for (const svc of services) {
    const serviceIP = await getSystemStaticIP(svc.containerName) || await getContainerIP(svc.containerName);
    if (!serviceIP) {
      throw new Error(`Cannot resolve IP for required system service ${svc.containerName}`);
    }
    const listenPort = svc.listenPort ?? svc.port;
    expected[svc.name] = {
      type: 'proxy',
      bind: 'instance',
      listen: `tcp:0.0.0.0:${listenPort}`,
      connect: `tcp:${serviceIP}:${svc.port}`,
    };
    devices[svc.name] = expected[svc.name];
  }

  const patched = await incusRequest('PATCH', `/1.0/instances/${containerName}`, { devices });
  await waitForIncusOperation(patched, `Attach proxy devices to ${containerName}`);
  const readBack = await incusRequest<{ devices: Record<string, Record<string, string>> }>(
    'GET', `/1.0/instances/${containerName}`,
  );
  const observed = assertIncusSuccess(readBack, `Read back proxy devices on ${containerName}`).devices ?? {};
  for (const [name, expectedDevice] of Object.entries(expected)) {
    const actual = observed[name];
    if (!actual || Object.entries(expectedDevice).some(([key, value]) => actual[key] !== value)) {
      throw new AppNetworkStateError(`Proxy device ${name} did not read back exactly on ${containerName}`);
    }
  }
  console.log(`[app-network] Added ${services.length} proxy devices to ${containerName}`);
}

function systemProxyDeviceName(appId: string, serviceName: string): string {
  const safeAppId = appId.replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 32);
  return `app-${safeAppId}-${serviceName}`;
}

export async function addSystemProxyDevices(
  appId: string,
  services: ProxyService[],
): Promise<void> {
  if (services.length === 0) return;

  const gatewayIP = await getAppBridgeGatewayIP(appId);
  if (!gatewayIP) {
    throw new Error(`Cannot add system proxies for ${appId}: app bridge gateway not found`);
  }

  // nat-mode (kernel DNAT) requires each proxy be attached to the instance whose
  // STATIC IP it connects to — so group doorways by target instance and PATCH
  // each. This replaces the userspace forkproxy (~17 MiB RSS each) with an
  // nftables DNAT rule (~0 RAM). See plans/proxy-nat-mode-optimization.md.
  const byInstance = new Map<string, Record<string, Record<string, string>>>();
  for (const svc of services) {
    const serviceIP = await getSystemStaticIP(svc.containerName) || await getContainerIP(svc.containerName);
    if (!serviceIP) {
      throw new Error(`Cannot resolve IP for system service ${svc.containerName}`);
    }
    const listenPort = svc.listenPort ?? svc.port;
    const group = byInstance.get(svc.containerName) ?? {};
    group[systemProxyDeviceName(appId, svc.name)] = {
      type: 'proxy',
      bind: 'host',
      nat: 'true',
      listen: `tcp:${gatewayIP}:${listenPort}`,
      connect: `tcp:${serviceIP}:${svc.port}`,
    };
    byInstance.set(svc.containerName, group);
  }

  for (const [instance, newDevices] of byInstance) {
    const res = await incusRequest<{
      devices: Record<string, Record<string, string>>;
    }>('GET', `/1.0/instances/${instance}`);
    const metadata = assertIncusSuccess(res, `Read system proxy target ${instance}`);
    const devices = { ...metadata.devices, ...newDevices };
    const patched = await incusRequest('PATCH', `/1.0/instances/${instance}`, { devices });
    await waitForIncusOperation(patched, `Attach system proxies for ${appId} to ${instance}`);
    const readBack = await incusRequest<{ devices: Record<string, Record<string, string>> }>('GET', `/1.0/instances/${instance}`);
    const observed = assertIncusSuccess(readBack, `Read back system proxies on ${instance}`).devices ?? {};
    for (const [name, expected] of Object.entries(newDevices)) {
      const actual = observed[name];
      if (!actual || Object.entries(expected).some(([key, value]) => actual[key] !== value)) {
        throw new AppNetworkStateError(`System proxy ${name} did not read back exactly on ${instance}`);
      }
    }
  }
  console.log(`[app-network] Added ${services.length} nat-mode proxy devices for ${appId} on ${gatewayIP}`);
}

export async function removeSystemProxyDevices(appId: string): Promise<void> {
  const prefix = systemProxyDeviceName(appId, '');
  // nat-mode distributes doorways across the core instances they connect to,
  // so scan every instance a system service can live on (not just control).
  const allServices = await getSystemServices({ needsSharedDb: true, needsSSO: true, needsAI: true });
  const instances = Array.from(new Set(allServices.map((s) => s.containerName)));
  const failures: string[] = [];
  for (const instance of instances) {
    try {
      const res = await incusRequest<IncusInstanceWritable>('GET', `/1.0/instances/${instance}`);
      const metadata = assertIncusSuccess(res, `Read system proxy target ${instance}`);
      const devicePatch: IncusDeviceMergePatch = {};
      let removed = 0;
      for (const name of Object.keys(metadata.devices)) {
        if (name.startsWith(prefix)) {
          devicePatch[name] = null;
          removed++;
        }
      }
      if (removed > 0) {
        await applyInstanceDeviceMergePatch(
          instance,
          metadata,
          devicePatch,
          `Remove system proxies for ${appId} from ${instance}`,
        );
        console.log(`[app-network] Removed ${removed} system proxy devices for ${appId} from ${instance}`);
      }
      const readBack = await incusRequest<{ devices: Record<string, Record<string, string>> }>('GET', `/1.0/instances/${instance}`);
      const remaining = Object.keys(assertIncusSuccess(readBack, `Read back proxy cleanup on ${instance}`).devices ?? {})
        .filter((name) => name.startsWith(prefix));
      if (remaining.length > 0) throw new AppNetworkStateError(`Proxy devices still present: ${remaining.join(', ')}`);
    } catch {
      failures.push(`${instance}: cleanup or verification failed`);
    }
  }
  // Tear down the per-app egress ACL once container holders are gone.
  await removeAppEgressAcl(appId);
  if (failures.length > 0) {
    throw new Error(`Failed to remove system proxies for ${appId}: ${failures.join('; ')}`);
  }
}

export async function removeSystemProxyServiceDevices(
  appId: string,
  serviceNames: string[]
): Promise<void> {
  const selected = new Set(serviceNames.map((name) => systemProxyDeviceName(appId, name)));
  if (selected.size === 0) return;
  const allServices = await getSystemServices({ needsSharedDb: true, needsSSO: true, needsAI: true });
  const instances = Array.from(new Set(allServices.map((service) => service.containerName)));
  for (const instance of instances) {
    const response = await incusRequest<IncusInstanceWritable>('GET', `/1.0/instances/${instance}`);
    const metadata = assertIncusSuccess(response, `Read system proxy target ${instance}`);
    const patch: IncusDeviceMergePatch = {};
    for (const name of Object.keys(metadata.devices)) {
      if (selected.has(name)) patch[name] = null;
    }
    if (Object.keys(patch).length > 0) {
      await applyInstanceDeviceMergePatch(
        instance,
        metadata,
        patch,
        `Remove selected system proxies for ${appId} from ${instance}`
      );
    }
  }
}

// ─── Per-App Egress Isolation ACL ───────────────────────────

function appAclName(appId: string): string {
  return `ye-app-${appId.replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 32)}-egress`;
}

function canonicalAclRules(rules: Array<Record<string, string>>): string[] {
  return rules
    .map((rule) => JSON.stringify(Object.fromEntries(Object.entries(rule).sort(([left], [right]) => left.localeCompare(right)))))
    .sort();
}

async function buildAppEgressRules(
  appId: string,
  opts: { needsSharedDb: boolean; needsSSO: boolean; needsAI?: boolean },
): Promise<Array<Record<string, string>>> {
  const config = await loadAppNetworkConfig();
  const state = await readIpamState({ config, allowInitialize: false });
  const lease = state.leases.find((candidate) => candidate.appId === appId);
  if (!lease) throw new AppNetworkStateError(`Cannot build egress policy for ${appId}: app lease not found`);

  const ip = async (name: string) => (await getSystemStaticIP(name)) || (await getContainerIP(name));
  const [uiIP, pgIP, controlIP, caddyIP, piholeIP, pointerIP] = await Promise.all([
    ip('youeye-ui'), ip('youeye-postgres'), ip('youeye-control'), ip('youeye-caddy'), ip('youeye-pihole'), ip('youeye-pointer'),
  ]);
  if (!uiIP || !pgIP || !controlIP) {
    throw new Error(`Cannot resolve core IPs for ${appId} egress ACL`);
  }

  const egress: Array<Record<string, string>> = [
    { action: 'allow', destination: lease.cidr, description: 'own app subnet: peers, gateway DNS, and proxied doorways' },
    { action: 'allow', protocol: 'tcp', destination: `${uiIP}/32`, destination_port: '3000', description: 'UI bridge' },
  ];
  if (opts.needsSSO) {
    egress.push({ action: 'allow', protocol: 'tcp', destination: `${controlIP}/32`, destination_port: '3001', description: 'identity service' });
  }
  if (opts.needsSharedDb) {
    egress.push({ action: 'allow', protocol: 'tcp', destination: `${pgIP}/32`, destination_port: '5432', description: 'shared Postgres' });
  }
  if (opts.needsAI) {
    if (!pointerIP) throw new Error(`Cannot resolve Pointer inference IP for ${appId} egress ACL`);
  }
  egress.push({ action: 'reject', protocol: 'tcp', destination: `${controlIP}/32`, destination_port: '3000', description: 'block CP dashboard' });
  if (!opts.needsSharedDb) {
    egress.push({ action: 'reject', destination: `${pgIP}/32`, description: 'block Postgres (non-DB app)' });
  }
  if (caddyIP) egress.push({ action: 'reject', destination: `${caddyIP}/32`, description: 'block Caddy administration' });
  if (piholeIP) egress.push({ action: 'reject', destination: `${piholeIP}/32`, description: 'block Pi-Hole administration' });
  if (pointerIP) egress.push({ action: 'reject', destination: `${pointerIP}/32`, description: 'block direct Pointer access; use the app gateway' });

  for (const pool of config.pools) {
    const denied = cidrContains(pool, lease.cidr) ? cidrComplement(pool, lease.cidr) : [pool];
    for (const destination of denied) {
      egress.push({
        action: 'reject',
        destination,
        description: `default-deny routed traffic to app pool outside ${lease.cidr}`,
      });
    }
  }
  // Incus requires an explicit state on every ACL rule. Omitting it is not a
  // default-enabled shorthand: current Incus rejects the complete ACL write.
  return egress.map((rule) => ({ state: 'enabled', ...rule }));
}

export async function prepareAppEgressAcl(
  appId: string,
  opts: { needsSharedDb: boolean; needsSSO: boolean; needsAI?: boolean },
): Promise<string> {
  const name = appAclName(appId);
  const egress = await buildAppEgressRules(appId, opts);
  const body = { name, description: `Default-deny routed app isolation for ${appId}`, egress, ingress: [] as unknown[] };
  const existing = await incusRequest(
    'GET',
    `/1.0/network-acls/${name}`,
    undefined,
    { timeout: NETWORK_OBJECT_TIMEOUT_MS },
  );
  if (existing.type === 'error' && (existing.status_code === 404 || existing.error_code === 404)) {
    const created = await incusRequest('POST', '/1.0/network-acls', body, { timeout: 120_000 });
    await waitForIncusOperation(created, `Create app ACL ${name}`, 180);
  } else {
    assertIncusSuccess(existing, `Read app ACL ${name}`);
    const replaced = await incusRequest('PUT', `/1.0/network-acls/${name}`, {
      description: body.description,
      egress,
      ingress: [],
      config: {},
    }, { timeout: 120_000 });
    await waitForIncusOperation(replaced, `Replace app ACL ${name}`, 180);
  }
  const readBack = await incusRequest<{ egress?: Array<Record<string, string>> }>(
    'GET',
    `/1.0/network-acls/${name}`,
    undefined,
    { timeout: NETWORK_OBJECT_TIMEOUT_MS },
  );
  const observed = assertIncusSuccess(readBack, `Read back app ACL ${name}`).egress ?? [];
  if (JSON.stringify(canonicalAclRules(observed)) !== JSON.stringify(canonicalAclRules(egress))) {
    throw new AppNetworkStateError(`App ACL ${name} did not read back with the exact isolation policy`);
  }
  return name;
}

/**
 * Apply the per-app egress isolation ACL. An app may reach ONLY its bridge
 * gateway (DNS + its proxied doorways) and the specific core services it is
 * entitled to (UI, identity if SSO, shared Postgres if a DB app). Direct access
 * to the CP dashboard, Caddy admin, Pi-Hole, and Postgres (for non-DB apps) is
 * rejected.
 *
 * Rules MUST be port-specific: Incus orders reject rules before allow rules, so
 * a broad subnet reject would shadow the allows — and would also break nat-mode,
 * whose DNAT'd legitimate traffic arrives with a core-IP destination. See the
 * master plan WS2.
 */
export async function applyAppEgressAcl(
  appId: string,
  containerNames: string[],
  opts: { needsSharedDb: boolean; needsSSO: boolean; needsAI?: boolean },
): Promise<void> {
  const name = await prepareAppEgressAcl(appId, opts);
  const bridgeName = await getAppBridgeName(appId);
  if (!bridgeName) throw new AppNetworkStateError(`Cannot apply policy for ${appId}: app bridge lease not found`);

  for (const cn of containerNames) {
    const res = await incusRequest<{ devices: Record<string, Record<string, string>> }>('GET', `/1.0/instances/${cn}`);
    const metadata = assertIncusSuccess(res, `Read primary NIC for ${cn}`);
    const devices = { ...metadata.devices };
    if (devices.eth0) {
      if (devices.eth0.network !== bridgeName) {
        throw new AppNetworkStateError(
          `Container ${cn} primary NIC is on ${devices.eth0.network ?? 'no network'}, expected ${bridgeName}`,
        );
      }
      devices.eth0 = {
        ...devices.eth0,
        'security.acls': name,
        'security.acls.default.egress.action': 'allow',
        'security.acls.default.ingress.action': 'allow',
        'security.mac_filtering': 'true',
        'security.ipv4_filtering': 'true',
      };
      const patched = await incusRequest('PATCH', `/1.0/instances/${cn}`, { devices });
      await waitForIncusOperation(patched, `Apply primary app NIC policy to ${cn}`);
      const readBack = await incusRequest<{ devices: Record<string, Record<string, string>> }>('GET', `/1.0/instances/${cn}`);
      const eth0 = assertIncusSuccess(readBack, `Read back primary NIC policy on ${cn}`).devices?.eth0;
      for (const [key, value] of Object.entries(devices.eth0)) {
        if (eth0?.[key] !== value) {
          throw new AppNetworkStateError(`Primary NIC policy did not read back on ${cn}: ${key}`);
        }
      }
    } else {
      throw new AppNetworkStateError(`Container ${cn} has no primary eth0 NIC for isolation policy`);
    }
  }
  console.log(`[app-network] Applied egress ACL ${name} to ${containerNames.join(', ')}`);
}

/** Remove the per-app egress ACL (best-effort; safe once container holders are gone). */
export async function removeAppEgressAcl(appId: string): Promise<void> {
  const name = appAclName(appId);
  const existing = await incusRequest(
    'GET',
    `/1.0/network-acls/${name}`,
    undefined,
    { timeout: NETWORK_OBJECT_TIMEOUT_MS },
  );
  if (existing.type === 'error' && (existing.error_code === 404 || existing.status_code === 404)) return;
  assertIncusSuccess(existing, `Read app ACL ${name}`);
  const deleted = await incusRequest('DELETE', `/1.0/network-acls/${name}`, undefined, { timeout: 120_000 });
  await waitForIncusOperation(deleted, `Delete app ACL ${name}`, 180);
  const readBack = await incusRequest(
    'GET',
    `/1.0/network-acls/${name}`,
    undefined,
    { timeout: NETWORK_OBJECT_TIMEOUT_MS },
  );
  if (!(readBack.type === 'error' && (readBack.error_code === 404 || readBack.status_code === 404))) {
    throw new AppNetworkStateError(`App ACL ${name} still exists after deletion`);
  }
  console.log(`[app-network] Removed egress ACL ${name}`);
}

/**
 * Remove all proxy devices from a container (cleanup on uninstall).
 */
export async function removeProxyDevices(containerName: string): Promise<void> {
  const res = await incusRequest<{
    devices: Record<string, Record<string, string>>;
  }>('GET', `/1.0/instances/${containerName}`);
  if (res.type === 'error' && (res.error_code === 404 || res.status_code === 404)) return;
  const metadata = assertIncusSuccess(res, `Read proxy cleanup target ${containerName}`);
  const devices = { ...metadata.devices };
  const removedNames: string[] = [];

  for (const [name, device] of Object.entries(devices)) {
    if (device.type === 'proxy' && device.bind === 'instance') {
      delete devices[name];
      removedNames.push(name);
    }
  }

  if (removedNames.length > 0) {
    const patched = await incusRequest('PATCH', `/1.0/instances/${containerName}`, { devices });
    await waitForIncusOperation(patched, `Remove proxy devices from ${containerName}`);
    const readBack = await incusRequest<{ devices: Record<string, Record<string, string>> }>(
      'GET', `/1.0/instances/${containerName}`,
    );
    const observed = assertIncusSuccess(readBack, `Read back proxy cleanup on ${containerName}`).devices ?? {};
    const remaining = removedNames.filter((name) => observed[name]);
    if (remaining.length > 0) {
      throw new AppNetworkStateError(`Proxy devices still exist on ${containerName}: ${remaining.join(', ')}`);
    }
    console.log(`[app-network] Removed ${removedNames.length} proxy devices from ${containerName}`);
  }
}

// ─── Cross-App NIC Permissions ──────────────────────────────

function integrationAclName(containerName: string, targetAppId: string): string {
  const safe = `${containerName}-to-${targetAppId}`.replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 42);
  return `ye-grant-${safe}`;
}

async function prepareIntegrationAcl(containerName: string, targetAppId: string): Promise<string> {
  const lease = await getAppNetworkLease(targetAppId);
  if (!lease || lease.state !== 'active') {
    throw new AppNetworkStateError(`Target app ${targetAppId} has no active network lease`);
  }
  const name = integrationAclName(containerName, targetAppId);
  const egress = [{
    action: 'allow',
    destination: lease.cidr,
    description: `Explicit integration path to ${targetAppId}`,
  }];
  const existing = await incusRequest('GET', `/1.0/network-acls/${name}`);
  if (existing.type === 'error' && (existing.error_code === 404 || existing.status_code === 404)) {
    const created = await incusRequest('POST', '/1.0/network-acls', {
      name,
      description: `Scoped secondary-NIC integration from ${containerName} to ${targetAppId}`,
      egress,
      ingress: [],
    });
    await waitForIncusOperation(created, `Create integration ACL ${name}`);
  } else {
    assertIncusSuccess(existing, `Read integration ACL ${name}`);
    const updated = await incusRequest('PUT', `/1.0/network-acls/${name}`, {
      description: `Scoped secondary-NIC integration from ${containerName} to ${targetAppId}`,
      egress,
      ingress: [],
      config: {},
    });
    await waitForIncusOperation(updated, `Update integration ACL ${name}`);
  }
  const readBack = await incusRequest<{ egress?: Array<Record<string, string>> }>('GET', `/1.0/network-acls/${name}`);
  const observed = assertIncusSuccess(readBack, `Read back integration ACL ${name}`).egress ?? [];
  if (JSON.stringify(canonicalAclRules(observed)) !== JSON.stringify(canonicalAclRules(egress))) {
    throw new AppNetworkStateError(`Integration ACL ${name} did not read back exactly`);
  }
  return name;
}

/**
 * Grant a container access to another app's bridge by hot-plugging a NIC.
 * This is the NIC-based permission model: NIC on bridge = access granted.
 *
 * The container gets a new network interface that connects it to the target bridge.
 * systemd-resolved automatically picks up the new DNS server (the target bridge's
 * dnsmasq), so container names on the target bridge resolve immediately.
 */
export async function grantBridgeAccess(
  containerName: string,
  targetAppId: string,
): Promise<void> {
  const targetBridge = await getAppBridgeName(targetAppId);
  if (!targetBridge) {
    throw new AppNetworkStateError(`No bridge found for target ${targetAppId}`);
  }

  const deviceName = `net-${targetAppId}`;

  if (!(await bridgeExists(targetBridge))) {
    throw new AppNetworkStateError(`Target bridge ${targetBridge} does not exist`);
  }
  const targetNetwork = (await listIncusNetworks()).find((network) => network.name === targetBridge);
  if (!targetNetwork) throw new AppNetworkStateError(`Target bridge ${targetBridge} disappeared during grant preflight`);
  const alreadyAttached = (targetNetwork.used_by ?? []).some((reference) =>
    instanceNameFromUsedBy(reference) === containerName);
  const attachedInstances = new Set(
    (targetNetwork.used_by ?? []).map(instanceNameFromUsedBy).filter((name): name is string => Boolean(name)),
  );
  const lease = await getAppNetworkLease(targetAppId);
  if (!lease) throw new AppNetworkStateError(`Target bridge ${targetBridge} has no durable lease`);
  const maximumAttachments = cidrUsableAddresses(lease.cidr) - 1; // gateway consumes one usable address
  if (!alreadyAttached && attachedInstances.size >= maximumAttachments) {
    throw new AppNetworkCapacityError(
      `Target app ${targetAppId} has no free /${parseCIDR(lease.cidr).prefix} attachment address`,
    );
  }
  const aclName = await prepareIntegrationAcl(containerName, targetAppId);
  const res = await incusRequest<{
    devices: Record<string, Record<string, string>>;
  }>('GET', `/1.0/instances/${containerName}`);
  const metadata = assertIncusSuccess(res, `Read integration source ${containerName}`);
  const devices = { ...metadata.devices };
  const ifName = `eth-${targetAppId.substring(0, 11)}`;
  const expectedDevice = {
    type: 'nic',
    network: targetBridge,
    name: ifName,
    'security.acls': aclName,
    'security.acls.default.egress.action': 'reject',
    'security.acls.default.ingress.action': 'allow',
    'security.mac_filtering': 'true',
    'security.ipv4_filtering': 'true',
  };
  if (!devices[deviceName]) {
    devices[deviceName] = expectedDevice;
    const patched = await incusRequest('PATCH', `/1.0/instances/${containerName}`, { devices });
    await waitForIncusOperation(patched, `Grant ${containerName} access to ${targetBridge}`);
  }
  const readBack = await incusRequest<{ devices: Record<string, Record<string, string>> }>('GET', `/1.0/instances/${containerName}`);
  const observed = assertIncusSuccess(readBack, `Read back integration NIC on ${containerName}`).devices?.[deviceName];
  if (!observed || Object.entries(expectedDevice).some(([key, value]) => observed[key] !== value)) {
    throw new AppNetworkStateError(`Integration NIC ${deviceName} did not read back exactly on ${containerName}`);
  }
  console.log(`[app-network] Granted ${containerName} scoped access to ${targetBridge} (${targetAppId})`);

  try {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const activation = await execShell(
      containerName,
      `ip link set ${ifName} up && (dhclient ${ifName} 2>/dev/null || udhcpc -i ${ifName} 2>/dev/null)`,
      { timeout: 15_000 },
    );
    if (activation.exitCode !== 0) throw new Error('DHCP activation failed');
    const dns = await execShell(
      containerName,
      `GATEWAY=$(ip -4 route | grep "dev ${ifName}" | grep via | awk '{print $3}' | head -1); ` +
      `[ -z "$GATEWAY" ] && GATEWAY=$(ip -4 addr show ${ifName} | grep inet | awk '{print $2}' | cut -d/ -f1 | awk -F. '{print $1"."$2"."$3".1"}'); ` +
      `test -n "$GATEWAY" && resolvectl dns ${ifName} "$GATEWAY" && resolvectl domain ${ifName} ~youeye`,
      { timeout: 10_000 },
    );
    if (dns.exitCode !== 0) throw new Error('DNS scope configuration failed');
  } catch {
    await revokeBridgeAccess(containerName, targetAppId).catch(() => undefined);
    throw new Error(`Failed to activate scoped integration NIC ${deviceName}`);
  }
}

/**
 * Revoke a container's access to another app's bridge by removing the NIC.
 */
export async function revokeBridgeAccess(
  containerName: string,
  targetAppId: string,
): Promise<void> {
  const deviceName = `net-${targetAppId}`;

  const res = await incusRequest<{
    devices: Record<string, Record<string, string>>;
  }>('GET', `/1.0/instances/${containerName}`);
  const metadata = assertIncusSuccess(res, `Read integration source ${containerName}`);
  const devices = { ...metadata.devices };
  if (devices[deviceName]) {
    delete devices[deviceName];
    const updated = await incusRequest('PUT', `/1.0/instances/${containerName}`, {
      ...metadata,
      devices,
    });
    await waitForIncusOperation(updated, `Revoke ${containerName} access to ${targetAppId}`);
  }
  const readBack = await incusRequest<{ devices: Record<string, Record<string, string>> }>('GET', `/1.0/instances/${containerName}`);
  if (assertIncusSuccess(readBack, `Read back integration NIC removal on ${containerName}`).devices?.[deviceName]) {
    throw new AppNetworkStateError(`Integration NIC ${deviceName} still exists on ${containerName}`);
  }
  const aclName = integrationAclName(containerName, targetAppId);
  const acl = await incusRequest('GET', `/1.0/network-acls/${aclName}`);
  if (!(acl.type === 'error' && (acl.error_code === 404 || acl.status_code === 404))) {
    assertIncusSuccess(acl, `Read integration ACL ${aclName}`);
    const deleted = await incusRequest('DELETE', `/1.0/network-acls/${aclName}`);
    await waitForIncusOperation(deleted, `Delete integration ACL ${aclName}`);
  }
  const aclReadBack = await incusRequest('GET', `/1.0/network-acls/${aclName}`);
  if (!(aclReadBack.type === 'error' && (aclReadBack.error_code === 404 || aclReadBack.status_code === 404))) {
    throw new AppNetworkStateError(`Integration ACL ${aclName} still exists after revocation`);
  }
  console.log(`[app-network] Revoked ${containerName} access to ${targetAppId}`);
}

// ─── Container NIC Configuration ────────────────────────────

/**
 * Build NIC device config for a container on a per-app bridge.
 * Returns the device map to include in container creation payload.
 * Requires the bridge to already exist (subnet allocated).
 */
export async function buildAppNIC(appId: string): Promise<Record<string, Record<string, string>>> {
  const bridgeName = await getAppBridgeName(appId);
  if (!bridgeName) {
    throw new Error(`No bridge allocated for app ${appId} — call createAppNetwork() first`);
  }
  return {
    eth0: {
      type: 'nic',
      network: bridgeName,
      name: 'eth0',
      'security.acls': appAclName(appId),
      'security.acls.default.egress.action': 'allow',
      'security.acls.default.ingress.action': 'allow',
      'security.mac_filtering': 'true',
      'security.ipv4_filtering': 'true',
    },
  };
}

// ─── Durable State Reconciliation ──────────────────────────

export interface AppNetworkReconcileResult {
  repaired: string[];
  unresolved: string[];
}

function instanceNameFromUsedBy(reference: string): string | null {
  const match = reference.match(/\/instances\/([^/?]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

async function stopAffectedAppContainers(
  appId: string | null,
  network?: IncusNetwork,
): Promise<string[]> {
  const names = new Set<string>();
  if (appId) {
    try {
      const { readInstallMetadata } = await import('../market/metadata');
      const metadata = await readInstallMetadata(appId);
      for (const container of metadata?.containers ?? []) {
        const name = typeof container === 'string' ? container : container.containerName;
        if (name) names.add(name);
      }
    } catch {
      // Fall back to the affected network's holders below. The error that caused
      // this stop is retained by the caller as a critical Health issue.
    }
  }
  for (const reference of network?.used_by ?? []) {
    const name = instanceNameFromUsedBy(reference);
    if (name && !SYSTEM_CONTAINERS.includes(name)) names.add(name);
  }

  const stopped: string[] = [];
  for (const name of names) {
    const path = `/1.0/instances/${encodeURIComponent(name)}`;
    const before = await incusRequest<{ status?: string }>('GET', path);
    if (before.type === 'error' && (before.status_code === 404 || before.error_code === 404)) continue;
    const instance = assertIncusSuccess(before, `Observe affected app container ${name}`);
    if (instance.status !== 'Stopped') {
      const result = await incusRequest('PUT', `${path}/state`, {
        action: 'stop',
        force: true,
        timeout: 30,
      });
      await waitForIncusOperation(result, `Stop affected app container ${name}`);
    }
    const after = await incusRequest<{ status?: string }>('GET', path);
    if (assertIncusSuccess(after, `Read back affected app container ${name}`).status !== 'Stopped') {
      throw new Error(`Affected app container ${name} did not read back as Stopped`);
    }
    stopped.push(name);
  }
  return stopped;
}

function observationFailureRequiresWorkloadStop(error: unknown): boolean {
  if (!(error instanceof AppNetworkStateError)) return false;
  return ![
    'Cannot read or parse app network configuration',
    'Cannot inspect host IPv4 routes',
    'Unowned Incus network name collision',
  ].some((message) => error.message.startsWith(message));
}

async function stopWorkloadsAfterObservationFailure(error: unknown): Promise<string[]> {
  if (!observationFailureRequiresWorkloadStop(error)) return [];
  const networks = await listIncusNetworks();
  const managed = networks.filter(isOwnedAppNetwork);
  let state: AppNetworkIpamState | null = null;
  try {
    const config = await loadAppNetworkConfig();
    state = await readIpamState({ config, allowInitialize: false });
  } catch {
    // A globally unreadable allocator makes every owned app bridge ambiguous.
  }
  const globalRoutingAmbiguity = error instanceof AppNetworkStateError
    && error.message.includes('overlaps current route or Incus network');
  const stopped = new Set<string>();
  for (const network of managed) {
    const lease = state?.leases.find((candidate) => candidate.bridgeName === network.name);
    let affected = state === null || !lease || globalRoutingAmbiguity;
    if (lease && !affected) {
      try {
        assertOwnedNetworkMatchesLease(network, lease);
      } catch {
        affected = true;
      }
    }
    if (!affected) continue;
    const appId = network.config?.[OWNERSHIP_APP_KEY];
    const safeAppId = appId && /^[a-z0-9][a-z0-9-]{0,62}$/.test(appId) ? appId : null;
    for (const name of await stopAffectedAppContainers(safeAppId, network)) stopped.add(name);
  }
  return [...stopped];
}

/**
 * Compare the strict allocator store with Incus and repair only resources whose
 * ownership is proved by the lease and Incus metadata. Ambiguous or corrupt
 * state is never adopted or deleted automatically.
 */
export async function reconcileAppNetworks(): Promise<AppNetworkReconcileResult> {
  const repaired: string[] = [];
  const unresolved: string[] = [];
  let observation: AppNetworkObservation;
  let activeInstalls: Set<string>;

  try {
    const { getAllActiveInstalls } = await import('../market/install-tracker');
    activeInstalls = new Set(getAllActiveInstalls().map((operation) => operation.appId));
    observation = await observeAppNetworkState();
    await resolveIssue(`${NETWORK_ISSUE_PREFIX}.state`);
  } catch (error) {
    const message = safeNetworkFailure(error);
    unresolved.push(`app-network-state:${message}`);
    let bootstrapRepair: AppNetworkBootstrapResult | null = null;
    try {
      bootstrapRepair = await canRepairEmptyAppNetworkBootstrap();
    } catch {
      // A repair action is offered only when a second independent inventory
      // proves the exact empty-install preconditions.
    }
    let stopped: string[] = [];
    try {
      stopped = await stopWorkloadsAfterObservationFailure(error);
    } catch {
      unresolved.push('app-network-state-stop:stop-or-verification-failed');
    }
    await observeIssue({
      id: `${NETWORK_ISSUE_PREFIX}.state`,
      severity: 'critical',
      source: 'app-network',
      title: bootstrapRepair?.eligible
        ? 'App network pool collides with the appliance network'
        : 'App network ownership state requires attention',
      body: `Allocator, route, or Incus ownership state could not be verified. App installs are blocked and no ambiguous network was adopted or deleted. ${bootstrapRepair?.eligible ? `${bootstrapRepair.reason}. The guarded repair is available because no app metadata, leases, active installs, or app bridges exist. ` : ''}${stopped.length > 0 ? `Only workloads on affected owned bridges were stopped: ${stopped.join(', ')}. ` : ''}${message}`,
      fixable: bootstrapRepair?.eligible === true,
      repairFn: bootstrapRepair?.eligible ? 'repair-empty-app-network' : null,
      learnMore: '/settings/system/health',
      debounce: 1,
    });
    return { repaired, unresolved };
  }

  for (const originalLease of [...observation.state.leases]) {
    const network = observation.networks.find((candidate) => candidate.name === originalLease.bridgeName);
    try {
      if (network) assertOwnedNetworkMatchesLease(network, originalLease);

      if (originalLease.state === 'reserved' && activeInstalls.has(originalLease.appId)) {
        // A live installer owns this transitional lease.
        continue;
      }

      if (originalLease.state === 'reserved' || originalLease.state === 'cleanup_pending') {
        if (originalLease.state === 'reserved') {
          await mutateIpamState({ config: observation.config, allowInitialize: false }, (state) =>
            transitionLease(state, originalLease.appId, 'cleanup_pending', {
              operationId: originalLease.operationId,
              failure: {
                stage: 'reconcile-interrupted-reservation',
                message: 'No live durable install operation owns this reservation',
                observedAt: new Date().toISOString(),
              },
            }),
          );
        }
        const { cleanupAppByScan } = await import('../market/reconciler');
        const cleanup = await withAppNetworkOperationLock(originalLease.appId, 'reconcile-cleanup', () =>
          cleanupAppByScan(originalLease.appId, { keepData: true, dropDatabase: false }),
        );
        repaired.push(...cleanup.repaired.map((item) => `app-network:${item}`));
        if (cleanup.unresolved.length > 0) {
          throw new Error(cleanup.unresolved.join('; '));
        }
        await resolveIssue(`${NETWORK_ISSUE_PREFIX}.${originalLease.appId}`);
        continue;
      }

      if (!network) {
        throw new AppNetworkStateError(
          `Active lease ${originalLease.appId} owns ${originalLease.bridgeName}, but the bridge is absent`,
        );
      }

      const { readInstallMetadata } = await import('../market/metadata');
      const metadata = await readInstallMetadata(originalLease.appId);
      if (!metadata) {
        throw new AppNetworkStateError(
          `Active lease ${originalLease.appId} has no install metadata; refusing automatic adoption or deletion`,
        );
      }
      if (metadata.lifecycleState === 'installing' && !activeInstalls.has(originalLease.appId)) {
        await mutateIpamState({ config: observation.config, allowInitialize: false }, (state) =>
          transitionLease(state, originalLease.appId, 'cleanup_pending', {
            operationId: originalLease.operationId,
            failure: {
              stage: 'reconcile-interrupted-finalization',
              message: 'No live durable install operation owns installing metadata',
              observedAt: new Date().toISOString(),
            },
          }),
        );
        const { cleanupAppByScan } = await import('../market/reconciler');
        const cleanup = await withAppNetworkOperationLock(originalLease.appId, 'reconcile-finalization', () =>
          cleanupAppByScan(originalLease.appId),
        );
        repaired.push(...cleanup.repaired.map((item) => `app-network:${item}`));
        if (cleanup.unresolved.length > 0) throw new Error(cleanup.unresolved.join('; '));
        await resolveIssue(`${NETWORK_ISSUE_PREFIX}.${originalLease.appId}`);
        continue;
      }
      const containerNames = (metadata.containers ?? [])
        .map((container) => typeof container === 'string' ? container : container.containerName)
        .filter((name): name is string => Boolean(name));
      if (containerNames.length === 0) {
        throw new AppNetworkStateError(`Active lease ${originalLease.appId} has no recorded containers`);
      }
      const needsSharedDb = metadata.databaseMode === 'shared';
      const needsSSO = metadata.hasSSO ?? metadata.enableSSO;
      const needsAI = metadata.aiConnection?.state !== undefined;
      await addCaddyToAppNetwork(originalLease.appId);
      await addSystemProxyDevices(
        originalLease.appId,
        await getSystemServices({ needsSharedDb, needsSSO, needsAI }),
      );
      await applyAppEgressAcl(originalLease.appId, containerNames, { needsSharedDb, needsSSO, needsAI });
      await resolveIssue(`${NETWORK_ISSUE_PREFIX}.${originalLease.appId}`);
    } catch (error) {
      // A supported install/remove/repair owns the same per-app lock. The
      // observation above is necessarily stale while that mutation is in
      // flight, so let its postconditions (and the next reconciliation pass)
      // decide health instead of raising a false critical issue.
      if (error instanceof AppNetworkOperationConflictError) continue;

      // Reconciliation observes the allocator and Incus before it starts
      // checking each lease. A supported uninstall can finish between that
      // snapshot and this catch block. If the exact lease no longer exists,
      // or has since advanced to a different operation/state, the failure was
      // derived from stale ownership state and must not become a persistent
      // critical issue that blocks the next install.
      try {
        const latest = await observeAppNetworkState();
        const currentLease = latest.state.leases.find(
          (candidate) => candidate.appId === originalLease.appId,
        );
        const leaseAdvanced = currentLease
          && (currentLease.operationId !== originalLease.operationId
            || currentLease.state !== originalLease.state
            || currentLease.bridgeName !== originalLease.bridgeName
            || currentLease.cidr !== originalLease.cidr);
        if (!currentLease || leaseAdvanced) {
          await resolveIssue(`${NETWORK_ISSUE_PREFIX}.${originalLease.appId}`);
          continue;
        }
      } catch {
        // If fresh ownership cannot be observed, retain the conservative
        // critical path below. Ambiguous state must never be auto-adopted.
      }

      let stopped: string[] = [];
      if (originalLease.state === 'active') {
        try {
          stopped = await stopAffectedAppContainers(originalLease.appId, network);
        } catch {
          unresolved.push(`app-network-stop:${originalLease.appId}:stop-or-verification-failed`);
        }
      }
      const message = safeNetworkFailure(error);
      unresolved.push(`app-network:${originalLease.appId}:${message}`);
      await observeIssue({
        id: `${NETWORK_ISSUE_PREFIX}.${originalLease.appId}`,
        severity: 'critical',
        source: 'app-network',
        title: `App network isolation could not be verified for ${originalLease.appId}`,
        body: `Lease ${originalLease.bridgeName} (${originalLease.cidr}) remains owned and non-reusable. ${stopped.length > 0 ? `Only the affected app containers were stopped: ${stopped.join(', ')}. ` : ''}${message}`,
        fixable: true,
        repairFn: 'reconcile-apps',
        learnMore: '/settings/system/health',
        debounce: 1,
      });
    }
  }

  return { repaired, unresolved };
}

// ─── Query Helpers ──────────────────────────────────────────

/**
 * List all per-app bridges.
 */
export async function listAppNetworks(): Promise<Array<{
  appId: string;
  bridgeName: string;
  subnet: number;
  subnetCIDR: string;
  state: AppNetworkLease['state'];
}>> {
  const observation = await observeAppNetworkState();
  return observation.state.leases.map((lease) => ({
    appId: lease.appId,
    bridgeName: lease.bridgeName,
    subnet: lease.bridgeId,
    subnetCIDR: lease.cidr,
    state: lease.state,
  }));
}

// System app IDs — the short names used in manifests and bridge records.
// Used by bridges/manager.ts and bridges/route.ts to reject bridges to system containers.
export const SYSTEM_APP_IDS = [
  'postgres', 'caddy', 'pihole', 'control', 'ui',
];

export { SYSTEM_CONTAINERS, BRIDGE_PREFIX };
export {
  AppNetworkOperationConflictError,
  AppNetworkStateError,
  withAppNetworkOperationLock,
};
