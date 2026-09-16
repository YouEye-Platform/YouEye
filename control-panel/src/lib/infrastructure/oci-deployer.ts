/**
 * OCI container deployment via Incus REST API.
 * Ported from Spine's internal/app/deploy.go → DeployOCIApp().
 */

import { incusRequest } from '../incus/server';
import { applyStaticIP } from '../incus/static-ips';
import type { OCIManifest } from './types';

/**
 * Parse an OCI image reference into server URL and alias.
 * "docker.io/library/caddy"            → { server: "https://docker.io", alias: "library/caddy" }
 * "ghcr.io/example/app:1.0"             → { server: "https://ghcr.io", alias: "example/app:1.0" }
 */
export function parseOCIImage(image: string): { server: string; alias: string } {
  const firstSlash = image.indexOf('/');
  if (firstSlash === -1) {
    return { server: 'https://docker.io', alias: 'library/' + image };
  }
  const serverPart = image.substring(0, firstSlash);
  const alias = image.substring(firstSlash + 1);
  return { server: `https://${serverPart}`, alias };
}

/** Check if an Incus container exists. */
export async function containerExists(name: string): Promise<boolean> {
  try {
    const resp = await incusRequest('GET', `/1.0/instances/${name}`);
    if (resp.status_code === 200) return true;
    if (resp.error && resp.error.includes('not found')) return false;
    return !!resp.metadata;
  } catch {
    return false;
  }
}

/**
 * Select devices added after the base OCI manifest was deployed.
 *
 * Per-app NAT doorways live on the system container they connect to (`app-*`),
 * while Caddy joins app bridges through `net-*` NICs. Recreating a system
 * container from only its base manifest must not silently discard either set.
 */
export function selectRuntimeExtensionDevices(
  devices: Record<string, Record<string, string>>,
): Record<string, Record<string, string>> {
  return Object.fromEntries(
    Object.entries(devices).filter(([name]) => name.startsWith('app-') || name.startsWith('net-')),
  );
}

async function readRuntimeExtensionDevices(
  containerName: string,
): Promise<Record<string, Record<string, string>>> {
  const response = await incusRequest<{
    devices?: Record<string, Record<string, string>>;
  }>('GET', `/1.0/instances/${containerName}`);
  return selectRuntimeExtensionDevices(response.metadata?.devices || {});
}

/** Get IPv4 address of a container. Uses static IPs for system containers. */
export { getContainerIP } from '../incus/container-ip';

export function classifyIncusOperationStatus(
  metadata: Record<string, unknown> | undefined,
): 'success' | 'failure' | 'pending' {
  const status = typeof metadata?.status === 'string' ? metadata.status.toLowerCase() : '';
  if (status === 'success') return 'success';
  if (status === 'failure' || status === 'cancelled' || status === 'canceled') return 'failure';
  return 'pending';
}

/**
 * Wait for an async Incus operation to reach a terminal state.
 *
 * Incus returns a successful HTTP response with `status: Running` when a
 * server-side `/wait?timeout=` interval expires. Treating that response as
 * completion can make a slow OCI import enter rollback while Incus is still
 * creating the instance. Poll in bounded chunks and accept only an explicit
 * terminal operation status.
 */
export async function waitForIncusOperation(operationPath: string, timeoutSeconds = 1800): Promise<void> {
  const deadline = Date.now() + timeoutSeconds * 1000;

  while (Date.now() < deadline) {
    const remainingSeconds = Math.max(1, Math.ceil((deadline - Date.now()) / 1000));
    const waitSeconds = Math.min(30, remainingSeconds);
    const resp = await incusRequest<Record<string, unknown>>(
      'GET',
      `${operationPath}/wait?timeout=${waitSeconds}`,
      undefined,
      { timeout: (waitSeconds + 10) * 1000 },
    );

    if (resp.type === 'error') {
      throw new Error(`Operation wait failed: ${resp.error || resp.status || 'unknown error'}`);
    }

    const meta = resp.metadata as Record<string, unknown> | undefined;
    const outcome = classifyIncusOperationStatus(meta);
    if (outcome === 'success') return;
    if (outcome === 'failure') {
      const errMsg = (meta?.err as string) || 'unknown error';
      throw new Error(`Operation failed: ${errMsg}`);
    }
  }

  throw new Error(`Operation did not complete within ${timeoutSeconds} seconds`);
}

export async function waitForContainerRunning(containerName: string, timeoutSeconds = 60): Promise<void> {
  for (let i = 0; i < timeoutSeconds; i++) {
    const state = await incusRequest<Record<string, unknown>>(
      'GET',
      `/1.0/instances/${containerName}/state`
    );
    const meta = state.metadata as Record<string, unknown> | undefined;
    if (meta && (meta.status as string) === 'Running') return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new Error(`Container ${containerName} did not reach Running state`);
}

export async function restartContainerAndWait(containerName: string, timeoutSeconds = 60): Promise<void> {
  const restartResult = await incusRequest<Record<string, unknown>>(
    'PUT',
    `/1.0/instances/${containerName}/state`,
    { action: 'restart', force: true, timeout: 30 },
  );
  if (restartResult.type === 'error') {
    throw new Error(`Container ${containerName} could not restart: ${restartResult.error || restartResult.status}`);
  }
  if (restartResult.type === 'async' && restartResult.operation) {
    await waitForIncusOperation(restartResult.operation, timeoutSeconds);
  }
  await waitForContainerRunning(containerName, timeoutSeconds);
}

export async function startOCIContainer(containerName: string, timeoutSeconds = 60): Promise<void> {
  const startResult = await incusRequest<Record<string, unknown>>(
    'PUT',
    `/1.0/instances/${containerName}/state`,
    { action: 'start' }
  );

  if (startResult.type === 'async' && startResult.operation) {
    await waitForIncusOperation(startResult.operation, timeoutSeconds);
  }

  await waitForContainerRunning(containerName, timeoutSeconds);
}

/**
 * Deploy an OCI container from a manifest.
 * If the container already exists (e.g. leftover from a failed install),
 * it is stopped and deleted before redeploying with the new config.
 */
export async function deployOCIContainer(
  manifest: OCIManifest,
  hostIP: string,
  nicDevices?: Record<string, Record<string, string>>,
  options?: { start?: boolean },
): Promise<void> {
  let runtimeExtensionDevices: Record<string, Record<string, string>> = {};

  // Clean up any leftover container from a failed previous install
  if (await containerExists(manifest.containerName)) {
    // Capture only known Control Panel-managed extension devices before the
    // instance is deleted. Base eth0/root/volume/proxy devices are rebuilt from
    // the current manifest and are intentionally not carried forward.
    runtimeExtensionDevices = await readRuntimeExtensionDevices(manifest.containerName);

    try {
      await incusRequest('PUT', `/1.0/instances/${manifest.containerName}/state`, {
        action: 'stop', force: true, timeout: 10,
      });
    } catch { /* may already be stopped */ }

    const delResult = await incusRequest('DELETE', `/1.0/instances/${manifest.containerName}`);
    if (delResult.type === 'async' && delResult.operation) {
      await incusRequest('GET', `${delResult.operation}/wait?timeout=30`);
    }
  }

  const remoteImage = manifest.imageFingerprint ? null : parseOCIImage(manifest.image);

  // Build Incus config (environment + limits + boot).
  // Manifests can override boot.autostart by setting `autostart: false`.
  // Currently only pihole opts out — see piholeManifest in manifests.ts
  // and YE-Wiki/spine/host-ip-migration.md for why.
  const config: Record<string, string> = {
    'boot.autostart': manifest.autostart === false ? 'false' : 'true',
  };
  for (const [key, value] of Object.entries(manifest.environment)) {
    config[`environment.${key}`] = value;
  }
  if (manifest.command) config['oci.entrypoint'] = manifest.command;

  // Build devices (port proxies + volume mounts)
  const devices: Record<string, Record<string, string>> = {};

  for (let i = 0; i < manifest.ports.length; i++) {
    const port = manifest.ports[i];
    const protocol = port.protocol || 'tcp';

    // Pi-Hole DNS: bind to host IP to avoid Incus dnsmasq conflict
    let listenAddr = `${protocol}:0.0.0.0:${port.host}`;
    if (manifest.name === 'pihole' && port.host === 53 && hostIP) {
      listenAddr = `${protocol}:${hostIP}:${port.host}`;
    }

    devices[`proxy${i}`] = {
      type: 'proxy',
      listen: listenAddr,
      connect: `${protocol}:127.0.0.1:${port.container}`,
    };
  }

  for (let i = 0; i < manifest.volumes.length; i++) {
    const vol = manifest.volumes[i];
    devices[`volume${i}`] = vol.kind === 'custom'
      ? {
          type: 'disk',
          pool: vol.pool,
          source: vol.source,
          path: vol.container,
          ...(vol.readOnly ? { readonly: 'true' } : {}),
        }
      : {
          type: 'disk',
          source: vol.host,
          path: vol.container,
          shift: 'true',
          ...(vol.readOnly ? { readonly: 'true' } : {}),
        };
  }

  Object.assign(devices, runtimeExtensionDevices);

  // Merge per-app bridge NIC devices if provided (overrides default profile NIC)
  if (nicDevices) {
    Object.assign(devices, nicDevices);
  }

  // Create container via Incus REST API
  // NOTE: Do NOT include "type": "container" — causes "Bad custom instance type"
  // with ghcr.io OCI images. Incus auto-detects the correct type.
  const createPayload = {
    name: manifest.containerName,
    source: manifest.imageFingerprint
      ? { type: 'image', fingerprint: manifest.imageFingerprint }
      : {
          type: 'image',
          server: remoteImage!.server,
          protocol: 'oci',
          alias: remoteImage!.alias,
        },
    config,
    devices,
  };

  const result = await incusRequest<Record<string, unknown>>(
    'POST',
    '/1.0/instances',
    createPayload,
    { timeout: 660_000 } // 11 min — image downloads can be slow
  );

  if (result.error && result.error !== '') {
    throw new Error(`Incus API error: ${result.error}`);
  }

  // Wait for async operation (image download + container creation)
  if (result.type === 'async' && result.operation) {
    await waitForIncusOperation(result.operation, 1800);
  }

  // Set static IP for system containers before starting (so first DHCP gives the right IP)
  try {
    await applyStaticIP(manifest.containerName);
  } catch (err) {
    console.warn(`[oci-deployer] Could not apply static IP to ${manifest.containerName}:`, err);
  }

  if (options?.start === false) return;

  await startOCIContainer(manifest.containerName);
}
