import { createHash } from 'node:crypto';
import type { IncusDeviceMap } from './device-merge-patch';

/** Linux interface names have at most 15 bytes; app IDs need not have unique prefixes. */
export function planCaddyAppNIC(appId: string, bridgeName: string, devices: IncusDeviceMap) {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(appId)) throw new Error('Invalid Caddy app identity');
  const deviceName = `net-${appId}`;
  const hashedName = `eth-${createHash('sha256').update(appId).digest('hex').slice(0, 11)}`;
  const legacyName = `eth-${appId.slice(0, 11)}`;
  const current = devices[deviceName];
  // Existing interfaces need no disruptive rename. Accept only the known legacy
  // or current name on this app's verified bridge, never an arbitrary attachment.
  const name = current?.name === legacyName ? legacyName : hashedName;
  if (current && (current.type !== 'nic' || current.network !== bridgeName || current.name !== name)) {
    throw new Error('Caddy app NIC does not match its installed network');
  }
  if (Object.entries(devices).some(([key, device]) =>
    key !== deviceName && device.type === 'nic' && device.name === name)) {
    throw new Error('Caddy app NIC interface name is already in use');
  }
  return { deviceName, device: { type: 'nic', network: bridgeName, name } };
}
