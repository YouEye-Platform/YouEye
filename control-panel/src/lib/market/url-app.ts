/**
 * Apps added by URL: fetch `youeye-app.yaml` and its setup files (relative to the manifest URL)
 * from a public HTTPS server, then parse them with the one app-format parser.
 *
 * Security: HTTPS only, no credentials in the URL, internal host names refused, and the host is
 * resolved first: every address it resolves to must be public (not private, loopback,
 * link-local, CGNAT, unique-local, multicast, reserved or a cloud metadata address). The request
 * connects to that checked address only (no second DNS lookup) and the connected peer address
 * is checked again. Redirects are refused, 1 MiB per file, short timeouts.
 */

import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { CONTAINER_DOMAIN } from './constants';
import { fetchApp } from './app-format/compile';
import { MAX_DOCUMENT_BYTES } from './app-format/parse';
import type { AppManifest } from './types';

const FETCH_TIMEOUT_MS = 5000;

const INTERNAL_NAMES = [/^localhost$/i, /\.local$/i, /\.internal$/i, /\.incus$/i, /\.test$/i, /\.localhost$/i];

/** Host names that are internal by name alone (addresses are checked after resolving). */
export function isPrivateHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (isIP(host)) return blockedAddress(host) !== null;
  return INTERNAL_NAMES.some((pattern) => pattern.test(host)) || host.endsWith(`.${CONTAINER_DOMAIN}`);
}

// ─── Address policy ───────────────────────────────────────

const BLOCKED = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) BLOCKED.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [
  ['::', 128], ['::1', 128], ['100::', 64], ['2001::', 23], ['2001:db8::', 32], ['2002::', 16],
  ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
] as const) BLOCKED.addSubnet(network, prefix, 'ipv6');

/** The IPv4 address inside an IPv4-mapped, -compatible or NAT64 IPv6 address. */
function embeddedIPv4(address: string): string | null {
  const dotted = /^(?:::ffff:|::|64:ff9b::)(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  if (dotted) return dotted[1];
  const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
  if (!hex) return null;
  const high = parseInt(hex[1], 16);
  const low = parseInt(hex[2], 16);
  return [high >> 8, high & 255, low >> 8, low & 255].join('.');
}

/** Why `address` may not be fetched from, or null for a public unicast address. */
export function blockedAddress(address: string): string | null {
  const family = isIP(address);
  if (family === 0) return 'not an IP address';
  if (family === 6) {
    const inner = embeddedIPv4(address.toLowerCase());
    if (inner) return blockedAddress(inner);
    if (address.toLowerCase().startsWith('fd00:ec2:')) return 'a cloud metadata address';
    return BLOCKED.check(address, 'ipv6') ? 'a private, loopback, link-local or reserved address' : null;
  }
  if (address === '169.254.169.254' || address === '100.100.100.200') return 'a cloud metadata address';
  return BLOCKED.check(address, 'ipv4') ? 'a private, loopback, link-local, CGNAT or reserved address' : null;
}

export type Resolver = (hostname: string) => Promise<string[]>;

const systemResolver: Resolver = async (hostname) =>
  (await dnsLookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);

export interface ResolvedHost {
  address: string;
  family: 4 | 6;
}

/** Resolve `hostname`; every address must be public. Returns the address to connect to. */
export async function resolvePublicHost(hostname: string, resolve: Resolver = systemResolver): Promise<ResolvedHost> {
  const host = hostname.replace(/^\[|\]$/g, '');
  let addresses: string[];
  try {
    addresses = isIP(host) ? [host] : await resolve(host);
  } catch {
    throw new UrlAppError(`Could not resolve ${host}`);
  }
  if (addresses.length === 0) throw new UrlAppError(`Could not resolve ${host}`);
  for (const address of addresses) {
    const reason = blockedAddress(address);
    if (reason) {
      throw new UrlAppError(`URL must point to a public server: ${host} resolves to ${address}, ${reason}`);
    }
  }
  return { address: addresses[0], family: isIP(addresses[0]) as 4 | 6 };
}

// ─── Fetch ────────────────────────────────────────────────

/** An error message when `url` may not be fetched (before resolving), or null. */
export function validateAppUrl(url: string): string | null {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return 'Invalid URL format'; }
  if (parsed.protocol !== 'https:') return 'Only HTTPS URLs are allowed';
  if (isPrivateHostname(parsed.hostname)) return 'URL must point to a public server (private/internal addresses are blocked)';
  if (parsed.username || parsed.password) return 'URLs with embedded credentials are not allowed';
  return null;
}

export class UrlAppError extends Error {
  constructor(message: string, readonly details: string[] = []) {
    super(message);
    this.name = 'UrlAppError';
  }
}

export interface PinnedResponse {
  status: number;
  contentType: string;
  body: string;
}

/** One HTTPS GET to `url`, connecting only to `pinned` (TLS still verifies the host name). */
export type PinnedGet = (url: URL, pinned: ResolvedHost) => Promise<PinnedResponse>;

/** A DNS lookup that always answers with the already checked address. */
export function pinnedLookup(pinned: ResolvedHost): LookupFunction {
  return ((_hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
    if (options?.all) callback(null, [{ address: pinned.address, family: pinned.family }]);
    else callback(null, pinned.address, pinned.family);
  }) as LookupFunction;
}

const pinnedHttpsGet: PinnedGet = (url, pinned) => new Promise((resolve, reject) => {
  const request = httpsRequest(url, {
    method: 'GET',
    // A fresh connection per request: a pooled socket could belong to another resolution.
    agent: false,
    lookup: pinnedLookup(pinned),
    ...(isIP(url.hostname.replace(/^\[|\]$/g, '')) ? {} : { servername: url.hostname }),
    headers: { Accept: 'text/yaml, application/yaml, text/plain, */*', 'User-Agent': 'YouEye-Market/1.0' },
  }, (response) => {
    const peer = response.socket.remoteAddress ?? '';
    if (peer !== pinned.address || blockedAddress(peer)) {
      response.destroy();
      reject(new UrlAppError('The server connection did not go to the checked address'));
      return;
    }
    const declared = Number(response.headers['content-length'] ?? '0');
    if (declared > MAX_DOCUMENT_BYTES) {
      response.destroy();
      reject(new UrlAppError('A manifest file exceeds the 1 MiB limit'));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    response.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_DOCUMENT_BYTES) {
        response.destroy();
        reject(new UrlAppError('A manifest file exceeds the 1 MiB limit'));
        return;
      }
      chunks.push(chunk);
    });
    response.on('end', () => resolve({
      status: response.statusCode ?? 0,
      contentType: String(response.headers['content-type'] ?? ''),
      body: Buffer.concat(chunks).toString('utf8'),
    }));
    response.on('error', reject);
  });
  request.setTimeout(FETCH_TIMEOUT_MS, () => request.destroy(new UrlAppError('Request timed out (5s limit)')));
  request.on('error', (error) => reject(error instanceof UrlAppError ? error : new UrlAppError('Failed to fetch the app manifest')));
  request.end();
});

export interface UrlFetchDeps {
  resolve: Resolver;
  get: PinnedGet;
}

const defaultDeps: UrlFetchDeps = { resolve: systemResolver, get: pinnedHttpsGet };

/** One file; null when the server says it does not exist (404). */
async function fetchText(url: string, required: boolean, deps: UrlFetchDeps): Promise<string | null> {
  const problem = validateAppUrl(url);
  if (problem) throw new UrlAppError(problem);
  const parsed = new URL(url);
  const pinned = await resolvePublicHost(parsed.hostname, deps.resolve);
  const response = await deps.get(parsed, pinned);
  if (response.status === 404 && !required) return null;
  if (response.status >= 300 && response.status < 400) {
    throw new UrlAppError(`Failed to fetch ${parsed.pathname}: HTTP ${response.status} (redirects are not followed)`);
  }
  if (response.status < 200 || response.status >= 300) throw new UrlAppError(`Failed to fetch ${parsed.pathname}: HTTP ${response.status}`);
  if (response.contentType.toLowerCase().includes('text/html')) {
    throw new UrlAppError('The URL returned an HTML document, not YAML');
  }
  if (Buffer.byteLength(response.body, 'utf8') > MAX_DOCUMENT_BYTES) throw new UrlAppError('A manifest file exceeds the 1 MiB limit');
  return response.body;
}

/** Fetch and strictly parse an app (manifest + setup files) from its manifest URL. */
export async function fetchUrlApp(manifestUrl: string, deps: UrlFetchDeps = defaultDeps): Promise<AppManifest> {
  const manifest = await fetchText(manifestUrl, true, deps);
  if (!manifest) throw new UrlAppError('The app manifest is empty');
  try {
    return await fetchApp(manifest, (name) => fetchText(new URL(name, manifestUrl).toString(), false, deps));
  } catch (error) {
    if (error instanceof UrlAppError) throw error;
    const issues = (error as { issues?: string[] }).issues;
    throw new UrlAppError('Invalid app manifest', issues ?? [error instanceof Error ? error.message : String(error)]);
  }
}
