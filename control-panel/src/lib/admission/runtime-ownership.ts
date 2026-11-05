import { incusRequest } from '@/lib/incus/server';
import { isUuid } from '../../../../shared/admission';

type RuntimeIdentity = { appId: string; installationId: string; ownerId: string; name: string };
type Instance = { name: string; config: Record<string, string> };

function readInstance(binding: RuntimeIdentity): Promise<Instance>;
function readInstance(binding: RuntimeIdentity, allowAbsent: boolean): Promise<Instance | null>;
async function readInstance(binding: RuntimeIdentity, allowAbsent = false): Promise<Instance | null> {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(binding.name)
    || !isUuid(binding.installationId) || !isUuid(binding.ownerId)) {
    throw new Error('Invalid runtime ownership');
  }
  const response = await incusRequest<Instance>('GET', `/1.0/instances/${encodeURIComponent(binding.name)}`);
  if (allowAbsent && response.type === 'error' && response.error_code === 404) return null;
  if (response.type === 'error' || response.metadata?.name !== binding.name) {
    throw new Error('Runtime identity is missing or mismatched');
  }
  return response.metadata;
}
function tags(binding: RuntimeIdentity) {
  return {
    'user.youeye.app_id': binding.appId,
    'user.youeye.installation_id': binding.installationId,
    'user.youeye.data_owner_id': binding.ownerId,
  };
}
export async function bindRuntimeOwnership(binding: RuntimeIdentity) {
  const current = await readInstance(binding);
  const expected = tags(binding);
  for (const [key, value] of Object.entries(expected)) {
    if (current.config?.[key] && current.config[key] !== value) {
      throw new Error('Runtime has foreign ownership');
    }
  }
  if (Object.entries(expected).every(([key, value]) => current.config?.[key] === value)) return;
  const result = await incusRequest('PATCH', `/1.0/instances/${encodeURIComponent(binding.name)}`,
    { config: expected });
  if (result.type === 'error') throw new Error('Runtime ownership write failed');
  if (result.type === 'async' && result.operation) {
    const waited = await incusRequest<{ status: string }>('GET', `${result.operation}/wait?timeout=60`);
    if (waited.type === 'error' || waited.metadata?.status === 'Failure') {
      throw new Error('Runtime ownership operation failed');
    }
  }
  await verifyRuntimeOwnership(binding);
}
export async function verifyRuntimeOwnership(binding: RuntimeIdentity, allowAbsent = false) {
  const current = await readInstance(binding, allowAbsent);
  if (!current) return;
  if (!Object.entries(tags(binding)).every(([key, value]) => current.config?.[key] === value)) {
    throw new Error('Runtime has unknown or foreign ownership');
  }
}
