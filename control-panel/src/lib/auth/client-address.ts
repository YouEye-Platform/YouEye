/**
 * The client's address for attempt limits (YE-136): taken from the TCP peer, never from a header a client wrote.
 *
 * Requests reach youeye-control's two processes (3000 the Control Panel, 3001 YouEye ID) these ways:
 * - through Caddy, from one of youeye-caddy's own addresses. Caddy's `reverse_proxy` has no trusted proxies, so it
 *   replaces any `X-Forwarded-For` a client sent with the peer it saw; since 0.6.17 that is the real client (PROXY
 *   protocol, `lib/caddy/client-address.ts`), before it 127.0.0.1;
 * - through an app's doorway to YouEye ID (gateway:3002 → :3001, an Incus NAT proxy device): the peer is the app's
 *   own address while its bridge does not NAT; when it does (the app has internet access), the bridge masquerades it
 *   to the host's address on incusbr0, which every such app shares. The app writes every header;
 * - through the UI's identity proxy (a forkproxy from the host): the host's incusbr0 address too;
 * - over loopback: the Control Panel itself, Spine's `port3000` device, commands run inside the container.
 *
 * The launcher (`scripts/bundle-node-runtime.mjs`) sets `x-youeye-peer` to the socket's remote address on every
 * request, replacing whatever the client sent. Then:
 * - a peer that is Caddy (its addresses read from Incus, `youeye-caddy`'s live state): the last `X-Forwarded-For`
 *   entry, the one Caddy wrote;
 * - a peer that is one of the host's own bridge addresses (shared by every app whose bridge NATs, and by the UI): no
 *   client address, so one app cannot use up a count that every other app shares;
 * - any other peer (an app whose bridge does not NAT): that peer, whatever headers it sent;
 * - loopback, no peer, no launcher (`YOUEYE_PEER_HEADER` unset: `next dev`; the header would be a client's) or roles that cannot be read from Incus: no client address.
 *   Keying an unknown peer on itself would put every browser behind Caddy into one count.
 *
 * No client address (null) means no per-address limit; the per-username limits still hold. Nothing here can lock
 * everyone out.
 */

import { incusRequest } from '@/lib/incus/server';

/** Set by the launcher from the TCP socket on every request; a client's own value never survives it. */
export const PEER_HEADER = 'x-youeye-peer';
/** The launcher sets this in the server's environment; without it (`next dev`) the header is a client's and is ignored. */
export const PEER_HEADER_FLAG = 'YOUEYE_PEER_HEADER';

/** Who a peer address is, as far as the limits care. */
export interface PeerRoles {
  /** youeye-caddy's addresses: its X-Forwarded-For is the client. */
  caddy: ReadonlySet<string>;
  /** The host's own bridge addresses: shared by every NATing app and the UI, never one client. */
  shared: ReadonlySet<string>;
}

/** A lowercased IPv4 or IPv6 address without the IPv4-mapped prefix, or null when it is not one. */
export function normalizeAddress(raw: string | null | undefined): string | null {
  const address = (raw || '').trim().toLowerCase().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '');
  if (!address || address.length > 45 || !/^[0-9a-f:.]+$/.test(address) || !/[.:]/.test(address)) return null;
  return address;
}

export function isLoopbackAddress(address: string): boolean {
  return address === '::1' || /^127\./.test(address);
}

/** The client's address, given the request's headers and the peer roles (null: unknown); null for no client. */
export function clientAddressFrom(headers: Headers, roles: PeerRoles | null): string | null {
  const peer = normalizeAddress(headers.get(PEER_HEADER));
  if (!peer || isLoopbackAddress(peer) || !roles) return null;
  if (roles.caddy.has(peer)) {
    const client = normalizeAddress(headers.get('x-forwarded-for')?.split(',').pop());
    return client && !isLoopbackAddress(client) ? client : null;
  }
  if (roles.shared.has(peer)) return null;
  return peer;
}

interface InstanceState {
  network?: Record<string, { addresses?: Array<{ family?: string; address?: string }> }> | null;
}

interface NetworkInfo {
  managed?: boolean;
  config?: Record<string, string>;
}

/** Peer roles from youeye-caddy's live state and the host's managed networks (their `ipv4/6.address`). */
export function peerRolesFrom(caddy: InstanceState | null | undefined, networks: NetworkInfo[] | null | undefined): PeerRoles {
  const caddyAddresses = new Set<string>();
  for (const [name, nic] of Object.entries(caddy?.network ?? {})) {
    if (name === 'lo') continue;
    for (const entry of nic.addresses ?? []) {
      const address = normalizeAddress(entry.address);
      if (address && !isLoopbackAddress(address)) caddyAddresses.add(address);
    }
  }
  const shared = new Set<string>();
  for (const network of Array.isArray(networks) ? networks : []) {
    if (network.managed === false) continue;
    for (const key of ['ipv4.address', 'ipv6.address']) {
      const address = normalizeAddress(network.config?.[key]?.split('/')[0]);
      if (address && !caddyAddresses.has(address)) shared.add(address);
    }
  }
  return { caddy: caddyAddresses, shared };
}

const ROLES_TTL_MS = 60_000;
/** A peer no role knows may be Caddy after a restart with a new address: look again, at most this often. */
const ROLES_MISS_REFRESH_MS = 5_000;
let rolesCache: { roles: PeerRoles; at: number } | null = null;
let rolesLoading: Promise<PeerRoles | null> | null = null;
let lastUnknownWarning = 0;

type IncusGet = <T>(path: string) => Promise<{ type?: string; metadata?: T }>;
const incusGet: IncusGet = (path) => incusRequest('GET', path, undefined, { timeout: 5_000 }) as never;

/** Read the peer roles from Incus; null when Caddy's addresses cannot be read. */
export async function loadPeerRoles(get: IncusGet = incusGet): Promise<PeerRoles | null> {
  const [caddy, networks] = await Promise.all([
    get<InstanceState>('/1.0/instances/youeye-caddy/state').catch(() => null),
    get<NetworkInfo[]>('/1.0/networks?recursion=1').catch(() => null),
  ]);
  if (!caddy || caddy.type === 'error' || !caddy.metadata) return null;
  const roles = peerRolesFrom(caddy.metadata, networks && networks.type !== 'error' ? networks.metadata : null);
  return roles.caddy.size > 0 ? roles : null;
}

async function peerRoles(peer: string, now = Date.now()): Promise<PeerRoles | null> {
  const cached = rolesCache;
  const known = cached && (cached.roles.caddy.has(peer) || cached.roles.shared.has(peer));
  if (cached && now - cached.at < ROLES_TTL_MS && (known || now - cached.at < ROLES_MISS_REFRESH_MS)) return cached.roles;
  rolesLoading ??= loadPeerRoles().finally(() => { rolesLoading = null; });
  const roles = await rolesLoading;
  if (roles) rolesCache = { roles, at: Date.now() };
  return roles ?? cached?.roles ?? null;
}

/** Forget the cached roles (tests). */
export function resetPeerRoles(): void {
  rolesCache = null;
}

/**
 * The request's client address for attempt limits, or null (loopback, shared, unknown): see the file comment.
 */
export async function requestClientAddress(headers: Headers): Promise<string | null> {
  if (process.env[PEER_HEADER_FLAG] !== '1') return null;
  const peer = normalizeAddress(headers.get(PEER_HEADER));
  if (!peer || isLoopbackAddress(peer)) return null;
  const roles = await peerRoles(peer);
  if (!roles) {
    const now = Date.now();
    if (now - lastUnknownWarning >= ROLES_TTL_MS) {
      lastUnknownWarning = now;
      console.warn('[auth] Caddy\'s addresses could not be read from Incus: no per-address attempt limits for now');
    }
    return null;
  }
  return clientAddressFrom(headers, roles);
}
