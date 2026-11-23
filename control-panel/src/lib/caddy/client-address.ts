/**
 * Real client addresses behind Caddy (YE-134).
 *
 * LAN and internet clients reach Caddy through `youeye-caddy`'s Incus proxy devices (`listen tcp:0.0.0.0:<port>`,
 * `connect tcp:127.0.0.1:<port>`), which open a new connection from inside the container: without more, Caddy sees
 * every client as 127.0.0.1. With `proxy_protocol: "true"` on a device, Incus sends a PROXY header with the real
 * client first, and Caddy's `proxy_protocol` listener wrapper (`servers.ts`) reads it.
 *
 * A device that sends headers to a server without the wrapper breaks that port completely (Caddy reads the header
 * as the TLS handshake or the HTTP request). So:
 * - the wrappers came one release before any device sends headers, and that release is the next one's minimum;
 * - at every Control Panel start, after the wrappers are converged, `reconcileClientAddressDevices` removes the flag
 *   from a device whose port has no server with the wrappers (self-heal), and sets it where the release sends
 *   headers (`PROXY_DEVICES_SEND_CLIENT_ADDRESS`) and the port's servers have the wrappers.
 *
 * Nothing here is stored outside Caddy's live config and the instance's devices; both are re-applied at each start.
 */

import { CLIENT_ADDRESS_PORTS, portReadsClientAddresses } from './servers';
import type { CaddyConfig } from './types';

export const CADDY_CONTAINER = 'youeye-caddy';

/**
 * Whether this release has the proxy devices send PROXY headers. False in 0.6.16 (release N: the wrappers only, and
 * the self-heal); true from the release whose minimum release is 0.6.16.
 */
export const PROXY_DEVICES_SEND_CLIENT_ADDRESS = false;

export type InstanceDevices = Record<string, Record<string, string>>;

export interface ClientAddressDeviceChange {
  device: string;
  port: number;
  proxyProtocol: boolean;
}

/** The names of the proxy devices that forward `port` to Caddy. */
export function caddyProxyDevicesForPort(devices: InstanceDevices, port: number): string[] {
  return Object.keys(devices).sort().filter((name) => devices[name]?.type === 'proxy'
    && devices[name]?.connect === `tcp:127.0.0.1:${port}`);
}

/** Incus reads a boolean device key as true for `true`, `1`, `yes` and `on`. */
function incusTrue(value: string | undefined): boolean {
  return ['true', '1', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());
}

/**
 * The devices with the flag where it belongs: removed where the port's servers lack the wrappers, added where
 * `send` and the wrappers are there. A flag on a port that has the wrappers stays even when `send` is false: a
 * Control Panel rolled back from a release that sends headers keeps real addresses, and stays safe.
 */
export function planClientAddressDevices(devices: InstanceDevices, config: CaddyConfig, send: boolean): {
  devices: InstanceDevices;
  changes: ClientAddressDeviceChange[];
} {
  const next = structuredClone(devices);
  const changes: ClientAddressDeviceChange[] = [];
  for (const port of CLIENT_ADDRESS_PORTS) {
    const ready = portReadsClientAddresses(config, port);
    for (const name of caddyProxyDevicesForPort(next, port)) {
      const device = next[name];
      const has = incusTrue(device.proxy_protocol);
      if (has && !ready) {
        delete device.proxy_protocol;
        changes.push({ device: name, port, proxyProtocol: false });
      } else if (!has && send && ready) {
        device.proxy_protocol = 'true';
        changes.push({ device: name, port, proxyProtocol: true });
      }
    }
  }
  return { devices: next, changes };
}

export interface ClientAddressDeviceDependencies {
  getConfig: () => Promise<CaddyConfig>;
  getDevices: () => Promise<InstanceDevices | null>;
  setDevices: (devices: InstanceDevices) => Promise<void>;
  send: boolean;
  log: (message: string) => void;
}

async function incusDevices(): Promise<InstanceDevices | null> {
  const { incusRequest } = await import('@/lib/incus/server');
  const response = await incusRequest<{ devices?: InstanceDevices }>('GET', `/1.0/instances/${CADDY_CONTAINER}`);
  if (response.type === 'error') {
    if (response.error_code === 404) return null;
    throw new Error(`Caddy instance unavailable: ${response.error}`);
  }
  return response.metadata?.devices ?? {};
}

/** The whole local device map (Incus merges or replaces by device; the whole map is right either way). */
async function setIncusDevices(devices: InstanceDevices): Promise<void> {
  const { incusRequest } = await import('@/lib/incus/server');
  const { waitForIncusOperation } = await import('@/lib/infrastructure/oci-deployer');
  const response = await incusRequest('PATCH', `/1.0/instances/${CADDY_CONTAINER}`, { devices });
  if (response.type === 'error') throw new Error(`Caddy proxy devices not updated: ${response.error}`);
  if (response.type === 'async' && response.operation) await waitForIncusOperation(response.operation, 60);
}

/**
 * At Control Panel start, after `ensureClientAddressListenerWrappers`: bring the flag on `youeye-caddy`'s :80 and
 * :443 proxy devices in line with the live Caddy config (see the file comment). Reads the devices back.
 * Returns the changes made.
 */
export async function reconcileClientAddressDevices(
  overrides: Partial<ClientAddressDeviceDependencies> = {},
): Promise<ClientAddressDeviceChange[]> {
  const deps: ClientAddressDeviceDependencies = {
    getConfig: async () => (await import('./client')).getConfig(),
    getDevices: incusDevices,
    setDevices: setIncusDevices,
    send: PROXY_DEVICES_SEND_CLIENT_ADDRESS,
    log: (message) => console.log(message),
    ...overrides,
  };
  const devices = await deps.getDevices();
  if (!devices) return [];
  // Fail safe: when Caddy's config cannot be read, nothing proves a server reads the headers, so no device may send
  // them (this removes every flag; a later run sets them again). The read error is thrown after.
  let configFailure: unknown;
  const config = await deps.getConfig().catch((error: unknown) => { configFailure = error; return {} as CaddyConfig; });
  const plan = planClientAddressDevices(devices, config, deps.send && !configFailure);
  if (plan.changes.length === 0) {
    if (configFailure) throw configFailure;
    return [];
  }
  await deps.setDevices(plan.devices);
  const after = await deps.getDevices();
  for (const change of plan.changes) {
    if (incusTrue(after?.[change.device]?.proxy_protocol) !== change.proxyProtocol) {
      throw new Error(`Caddy proxy device ${change.device} did not read back`);
    }
    deps.log(change.proxyProtocol
      ? `[Caddy] ${change.device} (:${change.port}) now sends the client's address (PROXY protocol)`
      : `[Caddy] ${change.device} (:${change.port}) stopped sending PROXY headers: the server on that port lacks the listener wrapper`);
  }
  if (configFailure) throw configFailure;
  return plan.changes;
}

/**
 * The health monitor's periodic check (every minute): only the device side, so a Caddy that came up on a config
 * without the wrappers (a restore of an older backup, a lost autosave, a rebuilt container) stops getting headers
 * within a minute instead of at the next Control Panel start. Never throws.
 */
export async function checkClientAddressDevices(): Promise<void> {
  try {
    await reconcileClientAddressDevices();
  } catch (error) {
    console.warn('[Caddy] client address check:', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Caddy's PROXY protocol listener wrappers on the live config, then the proxy devices in line with it. The devices
 * are reconciled even when the wrappers could not be written, so a device never keeps sending headers to a server
 * that cannot read them; the wrapper failure is thrown after.
 */
export async function ensureClientAddresses(
  ensureWrappers: () => Promise<boolean> = async () => (await import('./client')).ensureClientAddressListenerWrappers(),
  reconcile: () => Promise<unknown> = () => reconcileClientAddressDevices(),
): Promise<void> {
  let wrapperFailure: unknown;
  try {
    if (await ensureWrappers()) console.log('[Caddy] PROXY protocol listener wrappers added to the :80 and :443 servers');
  } catch (error) {
    wrapperFailure = error;
  }
  await reconcile();
  if (wrapperFailure) throw wrapperFailure;
}
