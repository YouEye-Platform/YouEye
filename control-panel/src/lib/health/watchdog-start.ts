import { withContainerLifecycle } from '../market/update-admission';
import { isContainerMaintenanceActive } from '../maintenance/container-maintenance';
import { listInstalledApps } from '../market/metadata';
import { inspectAppStorage } from '../market/storage';
import { incusRequest } from '../incus/server';
import { waitForIncusOperation } from '../infrastructure/oci-deployer';

/** A tick's inventory is only a hint. Admission and all start conditions must
 * remain true at action time, and the lock covers the terminal Incus operation. */
export async function startWatchdogContainer(name: string): Promise<boolean> {
  return withContainerLifecycle(name, async () => {
    if (isContainerMaintenanceActive(name)) return false;
    const owners = (await listInstalledApps()).filter(app => app.containers.some(c =>
      (typeof c === 'string' ? c : c.containerName) === name));
    if (owners.length > 1 || (name.startsWith('app-') && owners.length !== 1)) return false;
    for (const app of owners) {
      if (app.enabled === false || app.desiredState === 'stopped'
        || (app.lifecycleOperation?.desiredState === 'stopped' && app.lifecycleOperation.state !== 'completed')
        || !(await inspectAppStorage(app.storageVolumes)).available) return false;
    }
    const current = await incusRequest<{ status: string; config: Record<string, string> }>(
      'GET', `/1.0/instances/${encodeURIComponent(name)}`);
    if (current.type === 'error') throw new Error('Cannot verify watchdog start state');
    if (current.metadata?.status !== 'Stopped' || current.metadata?.config?.['boot.autostart'] === 'false') return false;
    const started = await incusRequest('PUT', `/1.0/instances/${encodeURIComponent(name)}/state`, { action: 'start', timeout: 30 });
    if (started.type === 'error') throw new Error(started.error || 'Watchdog start failed');
    if (started.operation) await waitForIncusOperation(started.operation, 60);
    return true;
  });
}
