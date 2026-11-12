import { mkdir, chmod } from 'node:fs/promises';
import { incusRequest, execCommand } from '@/lib/incus/server';
import { waitForOperation } from '@/lib/incus/snapshot';

export const POINTER_STORAGE = '/var/lib/youeye/pointer/runtime';
export const POINTER_STORAGE_DEVICE = { type: 'disk', source: POINTER_STORAGE, path: '/var/lib/pointer', shift: 'true' };

export async function preparePointerStorage() {
  await mkdir(POINTER_STORAGE, { recursive: true, mode: 0o700 });
  await chmod(POINTER_STORAGE, 0o700);
}

export async function ensurePointerStorage() {
  await preparePointerStorage();
  const read = await incusRequest<{ devices: Record<string, Record<string, string>>; expanded_devices?: Record<string, Record<string, string>> }>('GET', '/1.0/instances/youeye-pointer');
  if (read.error || !read.metadata) throw new Error('Pointer storage inspection failed');
  const existing = Object.values(read.metadata.expanded_devices ?? read.metadata.devices).find(device => device.path === '/var/lib/pointer');
  if (existing) {
    if (existing.type !== 'disk' || existing.source !== POINTER_STORAGE || existing.readonly === 'true') throw new Error('Pointer storage is not the expected persistent volume');
    return;
  }
  // Never hide an existing engine home by mounting over it. Appliances already
  // using file state need a paired backup and an explicit protected relocation.
  const empty = await execCommand('youeye-pointer', ['/bin/sh', '-c',
    'test ! -d /var/lib/pointer/engine || test -z "$(find /var/lib/pointer/engine -mindepth 1 -print -quit)"'], { timeout: 15_000 });
  if (empty.exitCode !== 0) throw new Error('Pointer engine files require a protected migration before mounting persistent storage');
  const patch = await incusRequest('PATCH', '/1.0/instances/youeye-pointer', { devices: {
    ...read.metadata.devices, 'pointer-state': POINTER_STORAGE_DEVICE,
  } });
  if (patch.error) throw new Error('Pointer persistent storage could not be attached');
  if (patch.operation) await waitForOperation(patch.operation, 60);
  const verified = await incusRequest<{ devices: Record<string, Record<string, string>> }>('GET', '/1.0/instances/youeye-pointer');
  if (verified.metadata?.devices['pointer-state']?.source !== POINTER_STORAGE) throw new Error('Pointer persistent storage readback failed');
}
