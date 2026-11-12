/** The setup runner's production transport: Incus file upload and exec APIs, and capped HTTP. */

import { appContainerAddress } from '@/lib/incus/app-network';
import { execCommand, incusUploadFile } from '@/lib/incus/server';
import { restartContainerAndWait } from '@/lib/infrastructure/oci-deployer';
import { cappedFetch, type SetupTransport } from './setup-runner';

export const incusSetupTransport: SetupTransport = {
  /** Only an address `checkAppAddress` accepts on `network`'s bridge (see `appContainerAddress`). */
  address: (container, network, iface) => appContainerAddress(container, network, iface),
  fetch: cappedFetch,
  exec: (container, argv, timeoutMs) => execCommand(container, argv, { timeout: timeoutMs }),
  writeFile: (container, path, data, mode) => incusUploadFile(container, path, data, { mode, createDirs: true }),
  restart: (container) => restartContainerAndWait(container, 120),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};
