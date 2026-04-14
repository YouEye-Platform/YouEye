/**
 * OCI container deployment via Incus REST API.
 * Ported from Spine's internal/app/deploy.go → DeployOCIApp().
 */

import { incusRequest } from '../incus/server';
import type { OCIManifest } from './types';
import { mkdir } from 'fs/promises';
import { existsSync } from 'fs';

/**
 * Parse an OCI image reference into server URL and alias.
 * "docker.io/library/caddy"            → { server: "https://docker.io", alias: "library/caddy" }
 * "ghcr.io/goauthentik/server:2025.12" → { server: "https://ghcr.io", alias: "goauthentik/server:2025.12" }
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

/** Get IPv4 address of a running container. */
export async function getContainerIP(containerName: string): Promise<string | null> {
  try {
    const resp = await incusRequest<Record<string, unknown>>('GET', `/1.0/instances/${containerName}/state`, undefined, { timeout: 5000 });
    const metadata = resp.metadata as Record<string, unknown> | undefined;
    if (!metadata) return null;

    const network = metadata.network as Record<string, unknown> | undefined;
    if (!network) return null;

    const eth0 = network.eth0 as { addresses?: Array<{ family: string; address: string; scope: string }> } | undefined;
    if (!eth0?.addresses) return null;

    for (const addr of eth0.addresses) {
      if (addr.family === 'inet' && addr.scope === 'global' && addr.address) {
        return addr.address;
      }
    }
  } catch { /* container may not be running */ }
  return null;
}

/**
 * Wait for an async Incus operation to complete.
 * Uses the /wait endpoint with a server-side timeout so we don't hold the socket open.
 */
async function waitForIncusOperation(operationPath: string, timeoutSeconds = 600): Promise<void> {
  const waitPath = `${operationPath}/wait?timeout=${timeoutSeconds}`;
  const resp = await incusRequest<Record<string, unknown>>('GET', waitPath, undefined, {
    timeout: (timeoutSeconds + 30) * 1000,
  });

  const meta = resp.metadata as Record<string, unknown> | undefined;
  if (!meta) return;

  const status = meta.status as string | undefined;
  if (status === 'Failure') {
    const errMsg = (meta.err as string) || 'unknown error';
    throw new Error(`Operation failed: ${errMsg}`);
  }
}

/**
 * Deploy an OCI container from a manifest.
 * If the container already exists (e.g. leftover from a failed install),
 * it is stopped and deleted before redeploying with the new config.
 */
export async function deployOCIContainer(
  manifest: OCIManifest,
  hostIP: string
): Promise<void> {
  // Clean up any leftover container from a failed previous install
  if (await containerExists(manifest.containerName)) {
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

  const { server, alias } = parseOCIImage(manifest.image);

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
    // Ensure host directory exists with restrictive permissions.
    // OCI apps run as non-root UIDs but shift=true handles UID mapping.
    if (!existsSync(vol.host)) {
      await mkdir(vol.host, { recursive: true, mode: 0o700 });
    }

    devices[`volume${i}`] = {
      type: 'disk',
      source: vol.host,
      path: vol.container,
      shift: 'true',
    };
  }

  // Create container via Incus REST API
  // NOTE: Do NOT include "type": "container" — causes "Bad custom instance type"
  // with ghcr.io OCI images. Incus auto-detects the correct type.
  const createPayload = {
    name: manifest.containerName,
    source: {
      type: 'image',
      server,
      protocol: 'oci',
      alias,
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
    await waitForIncusOperation(result.operation, 600);
  }

  // Start the container
  const startResult = await incusRequest<Record<string, unknown>>(
    'PUT',
    `/1.0/instances/${manifest.containerName}/state`,
    { action: 'start' }
  );

  if (startResult.type === 'async' && startResult.operation) {
    await waitForIncusOperation(startResult.operation, 60);
  }

  // Wait for container to be fully running
  for (let i = 0; i < 30; i++) {
    const state = await incusRequest<Record<string, unknown>>(
      'GET',
      `/1.0/instances/${manifest.containerName}/state`
    );
    const meta = state.metadata as Record<string, unknown> | undefined;
    if (meta && (meta.status as string) === 'Running') return;
    await new Promise((r) => setTimeout(r, 1000));
  }
}
