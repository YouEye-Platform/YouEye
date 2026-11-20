/** The setup runner's production transport: Incus file upload and exec APIs, and capped HTTP. */

import { appContainerAddress } from '@/lib/incus/app-network';
import { execCommand, incusUploadFile } from '@/lib/incus/server';
import { restartContainerAndWait } from '@/lib/infrastructure/oci-deployer';
import { containerRole } from '@/lib/apps/container-order';
import { cappedFetch, type SetupTransport } from './setup-runner';
import { listReadableInstalledApps } from './metadata';

/** The container's role from its app's install record, for its stop timeout; none while the app installs. */
async function installedRole(container: string): Promise<string | undefined> {
  const apps = await listReadableInstalledApps().catch(() => []);
  const owner = apps.find(app => app.containers.some(entry => entry.containerName === container));
  return owner ? containerRole(owner.containers, container) : undefined;
}

export const incusSetupTransport: SetupTransport = {
  /** Only an address `checkAppAddress` accepts on `network`'s bridge (see `appContainerAddress`). */
  address: (container, network, iface) => appContainerAddress(container, network, iface),
  fetch: cappedFetch,
  exec: (container, argv, timeoutMs) => execCommand(container, argv, { timeout: timeoutMs }),
  writeFile: (container, path, data, mode) => incusUploadFile(container, path, data, { mode, createDirs: true }),
  restart: async (container) => restartContainerAndWait(container, 120, { role: await installedRole(container) }),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};
