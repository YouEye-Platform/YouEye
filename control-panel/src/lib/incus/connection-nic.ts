import { createHash } from 'node:crypto';

/**
 * The interface a connection NIC to `peerAppId` gets inside the consumer's container (`grantBridgeAccess`).
 * Linux interface names have at most 15 bytes and app ids need not differ in their first 11 characters, so the
 * name holds a short hash of the id (as Caddy's app NICs do, `planCaddyAppNIC`).
 */
export function connectionInterface(peerAppId: string): string {
  return `eth-${createHash('sha256').update(peerAppId).digest('hex').slice(0, 11)}`;
}

/** The Incus network ACL of the connection NIC that lets `containerName` reach `targetAppId` (`grantBridgeAccess`). */
export function integrationAclName(containerName: string, targetAppId: string): string {
  const safe = `${containerName}-to-${targetAppId}`.replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 42);
  return `ye-grant-${safe}`;
}
