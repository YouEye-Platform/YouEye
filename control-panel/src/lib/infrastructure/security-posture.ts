import { incusRequest } from '@/lib/incus/server';
import { getSystemStaticIP } from '@/lib/incus/static-ips';
import { APP_TAG } from '@/lib/market/instance-ownership';

const UI_EGRESS_ACL = 'ye-ui-egress-block';

type InstanceMetadata = {
  devices: Record<string, Record<string, string>>;
};

export async function repairControlPanelProxy(): Promise<void> {
  const res = await incusRequest<InstanceMetadata>('GET', '/1.0/instances/youeye-control');
  const devices = { ...(res.metadata.devices || {}) };
  devices.port3000 = {
    type: 'proxy',
    bind: 'host',
    listen: 'tcp:127.0.0.1:3000',
    connect: 'tcp:127.0.0.1:3000',
  };
  await incusRequest('PATCH', '/1.0/instances/youeye-control', { devices });

  const verify = await incusRequest<InstanceMetadata>('GET', '/1.0/instances/youeye-control');
  const device = verify.metadata.devices?.port3000;
  if (
    !device ||
    device.listen !== 'tcp:127.0.0.1:3000' ||
    device.connect !== 'tcp:127.0.0.1:3000' ||
    device.bind !== 'host'
  ) {
    throw new Error('Control Panel port3000 proxy did not verify as localhost-only');
  }
}

export async function repairUIEgressAcl(): Promise<void> {
  const [controlIP, pointerIP] = await Promise.all([
    getSystemStaticIP('youeye-control'),
    getSystemStaticIP('youeye-pointer'),
  ]);
  if (!controlIP || !pointerIP) throw new Error('Cannot resolve core service static IPs');

  const body = {
    name: UI_EGRESS_ACL,
    description: 'Block UI container from reaching Control Panel services',
    ingress: [] as unknown[],
    egress: [
      {
        action: 'reject',
        state: 'enabled',
        protocol: 'tcp',
        destination: `${controlIP}/32`,
        destination_port: '3000,3001',
        description: 'Block UI from reaching Control Panel services',
      },
      {
        action: 'reject',
        state: 'enabled',
        protocol: 'tcp',
        destination: `${pointerIP}/32`,
        destination_port: '4001,4002',
        description: 'Block UI from reaching Pointer directly',
      },
    ],
    config: {},
  };

  try {
    await incusRequest('POST', '/1.0/network-acls', body);
  } catch {
    await incusRequest('PUT', `/1.0/network-acls/${UI_EGRESS_ACL}`, {
      description: body.description,
      ingress: body.ingress,
      egress: body.egress,
      config: {},
    });
  }

  const res = await incusRequest<InstanceMetadata>('GET', '/1.0/instances/youeye-ui');
  const devices = { ...(res.metadata.devices || {}) };
  devices.eth0 = {
    ...(devices.eth0 || { type: 'nic', network: 'incusbr0', name: 'eth0' }),
    'security.acls': UI_EGRESS_ACL,
    'security.acls.default.ingress.action': 'allow',
    'security.acls.default.egress.action': 'allow',
  };
  await incusRequest('PATCH', '/1.0/instances/youeye-ui', { devices });

  const verify = await incusRequest<InstanceMetadata>('GET', '/1.0/instances/youeye-ui');
  const eth0 = verify.metadata.devices?.eth0;
  if (
    !eth0 ||
    eth0['security.acls'] !== UI_EGRESS_ACL ||
    eth0['security.acls.default.ingress.action'] !== 'allow' ||
    eth0['security.acls.default.egress.action'] !== 'allow'
  ) {
    throw new Error('youeye-ui eth0 did not verify with UI egress ACL attached');
  }
}

export async function repairSystemSecurityPosture(): Promise<void> {
  await repairControlPanelProxy();
  await repairUIEgressAcl();
}

type AppInstance = {
  name?: string;
  config?: Record<string, string>;
  devices?: Record<string, Record<string, string>>;
};

/**
 * The host port the Market's native deploy used to add to every app (YE-189): `port<N>`, a host-side proxy on every
 * address of the box, plain HTTP and outside Caddy and the YouEye gate. Only this exact shape: an app's other
 * proxies (the doorways to the system services listen on 0.0.0.0 inside the app, `bind: instance`) and anything on
 * 127.0.0.1 are not it.
 */
export function isUnintendedAppHostPort(name: string, device: Record<string, string> | undefined): boolean {
  const port = /^port([1-9][0-9]{0,4})$/.exec(name)?.[1];
  return Boolean(port && device
    && device.type === 'proxy'
    && device.bind === 'host'
    && device.listen === `tcp:0.0.0.0:${port}`
    && device.connect === `tcp:127.0.0.1:${port}`);
}

/**
 * Remove the unintended host ports of installed apps (YE-189), once at each Control Panel start, so the normal
 * update cleans the boxes that got one. An app instance is one tagged with its app (`user.youeye.app_id`) or named
 * by an installed app's record (older installs carry no tag); the platform's own `youeye-*` containers are never
 * touched. Returns the devices removed, as `<instance>/<device>`.
 */
/** Runs `work` under the app's lifecycle lock; refuses (throws) when an operation on the app holds it. */
type AppLock = <T>(appId: string, work: () => Promise<T>) => Promise<T>;

const withAppLock: AppLock = async (appId, work) => {
  const { withAppLifecycle } = await import('@/lib/market/update-admission');
  return withAppLifecycle(appId, work, { automatic: true });
};

export async function removeAppHostPorts(
  recordedContainers: () => Promise<Map<string, string>> = async () => {
    const { listReadableInstalledApps } = await import('@/lib/market/metadata');
    return new Map((await listReadableInstalledApps()).flatMap((app) =>
      (app.containers ?? []).map((c) => [c.containerName, app.appId] as [string, string])));
  },
  lock: AppLock = withAppLock,
): Promise<string[]> {
  const listed = await incusRequest<AppInstance[]>('GET', '/1.0/instances?recursion=1');
  if (listed.type === 'error' || !Array.isArray(listed.metadata)) {
    throw new Error(`Incus instances could not be listed: ${listed.error || 'no list'}`);
  }
  const candidates = listed.metadata.filter((instance) =>
    instance.name && !instance.name.startsWith('youeye-')
    && Object.entries(instance.devices ?? {}).some(([name, device]) => isUnintendedAppHostPort(name, device)));
  if (candidates.length === 0) return [];

  const recorded = await recordedContainers();
  const removed: string[] = [];
  const failed: string[] = [];
  for (const instance of candidates) {
    const name = instance.name!;
    const appId = instance.config?.[APP_TAG] || recorded.get(name);
    if (!appId) continue; // not an app's instance
    try {
      // Under the app's lock: an update, reconfigure or network change of the app never interleaves with the
      // read-modify-PUT below (it would lose its change, or bring the port back). A busy app is left for the next
      // start.
      removed.push(...await lock(appId, () => removeHostPortsOf(name, appId, recorded)));
    } catch (error) {
      failed.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failed.length > 0) throw new Error(`Host ports left in place (${removed.length} removed): ${failed.join('; ')}`);
  return removed;
}

async function removeHostPortsOf(instanceName: string, appId: string, recorded: Map<string, string>): Promise<string[]> {
  const removed: string[] = [];
  const path = `/1.0/instances/${encodeURIComponent(instanceName)}`;
  const current = await incusRequest<AppInstance & Record<string, unknown>>('GET', path);
  if (current.type === 'error' || current.metadata?.name !== instanceName) return [];
  const owner = current.metadata.config?.[APP_TAG] || recorded.get(instanceName);
  if (owner !== appId) return [];
  const devices = { ...(current.metadata.devices ?? {}) };
  const bad = Object.keys(devices).filter((device) => isUnintendedAppHostPort(device, devices[device]));
  if (bad.length === 0) return [];
  for (const device of bad) delete devices[device];
  // PUT, not PATCH: Incus merges a PATCH's devices into the instance's, so a device left out stays.
  const put = await incusRequest('PUT', path, { ...current.metadata, devices });
  if (put.type === 'error') throw new Error(`Host port of ${instanceName} could not be removed: ${put.error}`);
  if (put.type === 'async' && put.operation) {
    const waited = await incusRequest<{ status?: string; err?: string }>(
      'GET', `${put.operation}/wait?timeout=60`, undefined, { timeout: 70_000 });
    if (waited.type === 'error' || waited.metadata?.status === 'Failure') {
      throw new Error(`Host port of ${instanceName} could not be removed: ${waited.metadata?.err || waited.error || 'operation failed'}`);
    }
  }
  const readBack = await incusRequest<AppInstance>('GET', path);
  const left = bad.filter((device) => readBack.type === 'error' || readBack.metadata?.devices?.[device]);
  if (left.length > 0) throw new Error(`Host port of ${instanceName} is still there: ${left.join(', ')}`);
  for (const device of bad) {
    console.log(`[security-posture] removed ${instanceName}'s host port ${device} (${current.metadata.devices?.[device]?.listen})`);
    removed.push(`${instanceName}/${device}`);
  }
  return removed;
}
