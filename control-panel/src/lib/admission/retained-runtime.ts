import { incusRequest } from '@/lib/incus/server';
import { waitForIncusOperation } from '@/lib/infrastructure/oci-deployer';
import { isAppId, isUuid } from '../../../../shared/admission';

export type RetainedRuntimeBinding = {
  appId: string; installationId: string; ownerId: string;
  sourceName: string; retainedName: string; pool: string;
};
type Instance = {
  name: string; status: string; config: Record<string, string>;
  devices: Record<string, Record<string, string>>;
  expanded_devices: Record<string, Record<string, string>>;
  profiles: string[];
};

function validate(binding: RetainedRuntimeBinding) {
  if (!isAppId(binding.appId) || !isUuid(binding.installationId) || !isUuid(binding.ownerId)
    || ![binding.sourceName, binding.retainedName, binding.pool].every(value =>
      /^[a-z0-9][a-z0-9-]{0,62}$/.test(value)) || binding.sourceName === binding.retainedName) {
    throw new Error('Invalid retained runtime identity');
  }
}
function ownership(binding: RetainedRuntimeBinding) {
  return {
    'user.youeye.app_id': binding.appId,
    'user.youeye.installation_id': binding.installationId,
    'user.youeye.data_owner_id': binding.ownerId,
  };
}
function retentionTags(binding: RetainedRuntimeBinding) {
  return { ...ownership(binding), 'user.youeye.retained_source': binding.sourceName };
}
async function read(name: string): Promise<Instance | null> {
  const result = await incusRequest<Instance>('GET', `/1.0/instances/${encodeURIComponent(name)}`);
  if (result.type === 'error' && result.error_code === 404) return null;
  if (result.type === 'error' || result.metadata?.name !== name) throw new Error('Cannot verify runtime identity');
  return result.metadata;
}
function verifyTags(instance: Instance, expected: Record<string, string>) {
  if (!Object.entries(expected).every(([key, value]) => instance.config?.[key] === value)) {
    throw new Error('Runtime has unknown or foreign data ownership');
  }
}
function rootDevice(instance: Instance, pool: string) {
  const roots = Object.entries(instance.expanded_devices || instance.devices || {})
    .filter(([, device]) => device.type === 'disk' && device.path === '/');
  if (roots.length !== 1 || roots[0][1].pool !== pool) throw new Error('Runtime root pool is mismatched');
  return Object.fromEntries(roots);
}
async function mutate(method: string, path: string, body?: unknown) {
  const result = await incusRequest(method, path, body);
  if (result.type === 'error') throw new Error('Retained runtime operation failed');
  if (result.type === 'async') {
    if (!result.operation) throw new Error('Retained runtime operation has no receipt');
    await waitForIncusOperation(result.operation, 1800);
  }
}

export async function runtimeExists(name: string) {
  return await read(name) !== null;
}

export async function verifyRetainedRuntime(binding: RetainedRuntimeBinding) {
  validate(binding);
  const instance = await read(binding.retainedName);
  if (!instance) throw new Error('Retained runtime is missing');
  verifyTags(instance, retentionTags(binding));
  rootDevice(instance, binding.pool);
  if (instance.status !== 'Stopped' || instance.config['boot.autostart'] !== 'false'
    || instance.profiles?.length !== 0
    || Object.values(instance.expanded_devices || instance.devices || {}).some(device =>
      device.type !== 'disk' || device.path !== '/')) {
    throw new Error('Retained runtime is not isolated and stopped');
  }
}

/** Copy only after stopping. Never delete the source until provider readback passes. */
export async function retainRuntime(binding: RetainedRuntimeBinding) {
  validate(binding);
  if (await read(binding.retainedName)) {
    await verifyRetainedRuntime(binding);
    return;
  }
  const source = await read(binding.sourceName);
  if (!source) throw new Error('Source runtime is missing before retention');
  verifyTags(source, ownership(binding));
  const root = rootDevice(source, binding.pool);
  if (source.status !== 'Stopped') {
    await mutate('PUT', `/1.0/instances/${binding.sourceName}/state`,
      { action: 'stop', timeout: 30 });
    const stopped = await read(binding.sourceName);
    if (!stopped || stopped.status !== 'Stopped') throw new Error('Source runtime did not stop');
    verifyTags(stopped, ownership(binding));
  }
  await mutate('POST', '/1.0/instances', {
    name: binding.retainedName, instance_only: true,
    source: { type: 'copy', source: binding.sourceName },
    config: { ...retentionTags(binding), 'boot.autostart': 'false' },
    profiles: [], devices: root, ephemeral: false,
  });
  const copied = await read(binding.retainedName);
  if (!copied || copied.status !== 'Stopped') throw new Error('Retained copy did not remain stopped');
  verifyTags(copied, retentionTags(binding));
  // Incus copy can inherit source devices. Replace them explicitly rather than
  // treating the copy request's overrides as evidence of network isolation.
  await mutate('PUT', `/1.0/instances/${binding.retainedName}`, {
    config: { ...copied.config, ...retentionTags(binding), 'boot.autostart': 'false' },
    devices: root, profiles: [], ephemeral: false,
  });
  await verifyRetainedRuntime(binding);
}

/** Reinstall copies the offline root; failed installs cannot destroy the retained original. */
export async function copyRetainedRuntime(
  binding: RetainedRuntimeBinding,
  options: { config?: Record<string, string>; devices?: Record<string, Record<string, string>> } = {},
) {
  await verifyRetainedRuntime(binding);
  if (await read(binding.sourceName)) throw new Error('Adoption target already exists');
  const retained = (await read(binding.retainedName))!;
  await mutate('POST', '/1.0/instances', {
    name: binding.sourceName, instance_only: true,
    source: { type: 'copy', source: binding.retainedName },
    config: { ...options.config, ...ownership(binding), 'boot.autostart': 'false' },
    profiles: [], devices: { ...options.devices, ...rootDevice(retained, binding.pool) }, ephemeral: false,
  });
  const copied = await read(binding.sourceName);
  if (!copied || copied.status !== 'Stopped') throw new Error('Adopted runtime did not remain stopped');
  verifyTags(copied, ownership(binding));
  rootDevice(copied, binding.pool);
}

/** Used only after successful adoption or an explicit delete-data operation. */
export async function deleteRetainedRuntime(binding: RetainedRuntimeBinding) {
  validate(binding);
  if (!await read(binding.retainedName)) return;
  await verifyRetainedRuntime(binding);
  await mutate('DELETE', `/1.0/instances/${binding.retainedName}`);
  if (await read(binding.retainedName)) throw new Error('Retained runtime cleanup did not converge');
}

export async function runtimeRootPool(name: string): Promise<string> {
  const instance = await read(name);
  if (!instance) throw new Error('Runtime root is missing');
  const roots = Object.values(instance.expanded_devices || instance.devices || {})
    .filter(device => device.type === 'disk' && device.path === '/');
  if (roots.length !== 1 || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(roots[0].pool || '')) {
    throw new Error('Runtime root pool is unresolved');
  }
  return roots[0].pool;
}
