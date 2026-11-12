import { createHash } from 'node:crypto';

/**
 * The interface a connection NIC to `peerAppId` gets inside the consumer's container (`grantBridgeAccess`).
 * Linux interface names have at most 15 bytes and app ids need not differ in their first 11 characters, so the
 * name holds a short hash of the id (as Caddy's app NICs do, `planCaddyAppNIC`).
 */
export function connectionInterface(peerAppId: string): string {
  return `eth-${createHash('sha256').update(peerAppId).digest('hex').slice(0, 11)}`;
}
