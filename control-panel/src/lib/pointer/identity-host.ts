import { isUsableIPv4 } from '@/lib/incus/ipv4';

const MARKER = '# youeye-managed-pointer-identity';

/** Resolve only the managed public identity authority through local Caddy.
 * Keep its public issuer, TLS hostname and signature verification unchanged.
 */
export function pointerIdentityHosts(current: string, hostname: string, caddyIP: string): string {
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(hostname)
    || hostname.length > 253 || !isUsableIPv4(caddyIP)) {
    throw new Error('Invalid managed Pointer identity address');
  }
  const lines = current.split('\n');
  const owned = lines.filter(line => line.endsWith(MARKER));
  if (owned.length > 1) throw new Error('Ambiguous managed Pointer identity records');
  const retained = lines.filter(line => !line.endsWith(MARKER));
  if (retained.some(line => line.split('#')[0].trim().split(/\s+/).slice(1)
    .some(alias => alias.toLowerCase() === hostname))) {
    throw new Error('Unmanaged Pointer identity address already exists');
  }
  return `${retained.join('\n').replace(/\n*$/, '')}\n${caddyIP}\t${hostname}\t${MARKER}\n`;
}
