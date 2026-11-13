import { createHash } from 'node:crypto';
import type { IncusDeviceMap } from './device-merge-patch';

/**
 * The ACL on every Caddy NIC on an app bridge. Apps may reach Caddy only on
 * HTTP and HTTPS; everything else (the admin API above all) is rejected. The
 * ACL is stateful, so Caddy's own connections to the app's upstreams and their
 * replies are unaffected, and Incus always admits DHCP on the NIC.
 */
export const CADDY_APP_ACL = 'ye-caddy-app-ingress';
export const CADDY_APP_ACL_DESCRIPTION = 'Apps reach Caddy only on HTTP and HTTPS';
export const CADDY_APP_ACL_INGRESS: Array<Record<string, string>> = [{
  action: 'allow',
  state: 'enabled',
  protocol: 'tcp',
  destination_port: '80,443',
  description: 'app traffic to Caddy HTTP and HTTPS',
}];

const CADDY_APP_NIC_POLICY = {
  'security.acls': CADDY_APP_ACL,
  'security.acls.default.ingress.action': 'reject',
  'security.acls.default.egress.action': 'allow',
};

/** Linux interface names have at most 15 bytes; app IDs need not have unique prefixes. */
export function planCaddyAppNIC(appId: string, bridgeName: string, devices: IncusDeviceMap) {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(appId)) throw new Error('Invalid Caddy app identity');
  const deviceName = `net-${appId}`;
  const name = `eth-${createHash('sha256').update(appId).digest('hex').slice(0, 11)}`;
  const current = devices[deviceName];
  // Accept only this app's planned name on its verified bridge, never an arbitrary attachment.
  if (current && (current.type !== 'nic' || current.network !== bridgeName || current.name !== name)) {
    throw new Error('Caddy app NIC does not match its installed network');
  }
  if (Object.entries(devices).some(([key, device]) =>
    key !== deviceName && device.type === 'nic' && device.name === name)) {
    throw new Error('Caddy app NIC interface name is already in use');
  }
  return { deviceName, device: { type: 'nic', network: bridgeName, name, ...CADDY_APP_NIC_POLICY } };
}

/** The part of `GET /1.0/instances/<name>/state` that NIC activation reads. */
export interface CaddyInstanceState {
  status?: string;
  network?: Record<string, {
    state?: string;
    addresses?: Array<{ family?: string; address?: string }>;
  }> | null;
}

/** True when Caddy's app interface is up and holds an IPv4 address. */
export function caddyAppNICIsActive(state: CaddyInstanceState, ifName: string): boolean {
  const nic = state.network?.[ifName];
  return nic?.state === 'up' && (nic.addresses ?? []).some(address => address.family === 'inet' && Boolean(address.address));
}

function assertInterfaceName(ifName: string): void {
  if (!/^eth-[a-z0-9-]{1,11}$/.test(ifName)) throw new Error('Invalid Caddy app interface name');
}

/** Caddy's writable scratch directory inside the container (overridable for tests). */
const RUN_DIR = '/tmp';

function dhcpPidFile(ifName: string, runDir: string): string {
  return `${runDir}/youeye-udhcpc-${ifName}.pid`;
}

/**
 * Bring up a NIC hot-plugged onto the running Caddy (OCI) container.
 *
 * Incus runs its DHCP client for an OCI container only for the NICs present at
 * start, so a NIC added later stays DOWN with no address and Caddy cannot reach
 * the app. This waits for the interface, sets it up and runs busybox udhcpc with
 * a hook that only manages the interface's own address (never routes or DNS).
 * udhcpc stays in the background to renew the lease (`-R` releases it on stop),
 * exactly as Incus's own client does for NICs present at start. Idempotent: an
 * interface that already holds an IPv4 address is only set up.
 */
export function caddyAppNICActivationScript(ifName: string, runDir = RUN_DIR): string {
  assertInterfaceName(ifName);
  const hook = [
    '#!/bin/sh',
    'case "$1" in',
    '  bound) ip -4 addr flush dev "$interface"; ip addr add "$ip/$mask" dev "$interface" ;;',
    '  renew) ip -4 addr show dev "$interface" | grep -q "inet $ip/" || ip addr add "$ip/$mask" dev "$interface" ;;',
    'esac',
    'exit 0',
  ];
  return [
    `IF='${ifName}'; HOOK='${runDir}/youeye-app-nic.udhcpc'; PID='${dhcpPidFile(ifName, runDir)}'`,
    'i=0; while ! ip link show "$IF" >/dev/null 2>&1; do i=$((i+1)); [ "$i" -ge 15 ] && exit 3; sleep 1; done',
    'ip link set "$IF" up || exit 4',
    'ip -4 addr show dev "$IF" | grep -q inet && exit 0',
    `printf '%s\\n' ${hook.map(line => `'${line.replace(/'/g, `'\\''`)}'`).join(' ')} > "$HOOK" && chmod 700 "$HOOK" || exit 5`,
    '[ -f "$PID" ] && kill "$(cat "$PID")" 2>/dev/null; rm -f "$PID"',
    'udhcpc -i "$IF" -s "$HOOK" -p "$PID" -R -n -t 5 -T 2 >/dev/null 2>&1 || exit 6',
    'ip -4 addr show dev "$IF" | grep -q inet || exit 7',
  ].join('\n');
}

/** Stop the background DHCP client started for an app interface (releasing its lease). */
export function caddyAppNICReleaseScript(ifName: string, runDir = RUN_DIR): string {
  assertInterfaceName(ifName);
  return [
    `PID='${dhcpPidFile(ifName, runDir)}'`,
    '[ -f "$PID" ] && kill "$(cat "$PID")" 2>/dev/null',
    'rm -f "$PID"',
    'exit 0',
  ].join('\n');
}
