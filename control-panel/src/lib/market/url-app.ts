/**
 * Apps added by URL: fetch `youeye-app.yaml` and its setup files (relative to the manifest URL)
 * from a public HTTPS server, then parse them with the one app-format parser.
 *
 * Security: HTTPS only, no credentials in the URL, internal host names refused, and the host is
 * resolved first: every address it resolves to must be public (not private, loopback,
 * link-local, CGNAT, unique-local, multicast, reserved or a cloud metadata address). The request
 * connects to that checked address only (no second DNS lookup) and the connected peer address
 * is checked again. Redirects are refused, 1 MiB per file, 5 s of silence at most, 20 s per file and 60 s for the
 * whole app (a server that sends a body slowly, or names many setup files, cannot hold a request open).
 */

import { lookup as dnsLookup } from 'node:dns/promises';
import type { IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest, type Agent as HttpsAgent } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { CONTAINER_DOMAIN } from './constants';
import { fetchApp } from './app-format/compile';
import { MAX_DOCUMENT_BYTES } from './app-format/parse';
import type { AppManifest } from './types';

const FETCH_TIMEOUT_MS = 5000;
/** One file, headers to last byte: 1 MiB at 50 kB/s. */
export const URL_APP_FILE_DEADLINE_MS = 20_000;
/** The manifest and every setup file it names, together. */
export const URL_APP_DEADLINE_MS = 60_000;
const TOO_SLOW = 'The app could not be read in time: its server answers too slowly';

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

/**
 * The manifest URL an "add by URL" address stands for. A repository address is read as its `youeye-app.yaml`:
 * `https://github.com/<owner>/<repo>` from raw.githubusercontent.com, `https://<forge>/<owner>/<repo>` (Forgejo, Gitea)
 * from its `main` branch. Anything else, and any address of a `.yaml`/`.yml` file, is used as it is.
 */
export function resolveAppManifestUrl(input: string): string {
  const github = input.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)\/?$/);
  if (github && !/\.ya?ml$/i.test(github[2])) {
    return `https://raw.githubusercontent.com/${github[1]}/${github[2]}/main/youeye-app.yaml`;
  }
  try {
    const repository = new URL(input);
    const parts = repository.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').split('/');
    if (repository.protocol === 'https:' && !repository.username && !repository.password &&
        !repository.search && !repository.hash && parts.length === 2 && parts.every(Boolean) &&
        !/\.ya?ml$/i.test(parts[1]) && !isPrivateHostname(repository.hostname)) {
      return `${repository.origin}/${parts.map(encodeURIComponent).join('/')}/raw/branch/main/youeye-app.yaml`;
    }
  } catch {
    // Not a URL: validateAppUrl says why.
  }
  return input;
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

/**
 * One HTTPS GET to `url`, connecting only to `pinned` (TLS still verifies the host name). `deadlineMs` is the time
 * the whole request may take (the rest of the app's time when that is less than a file's).
 */
export type PinnedGet = (url: URL, pinned: ResolvedHost, deadlineMs?: number) => Promise<PinnedResponse>;

/** A DNS lookup that always answers with the already checked address. */
export function pinnedLookup(pinned: ResolvedHost): LookupFunction {
  return ((_hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
    if (options?.all) callback(null, [{ address: pinned.address, family: pinned.family }]);
    else callback(null, pinned.address, pinned.family);
  }) as LookupFunction;
}

export interface PinnedRequestOptions {
  headers: Record<string, string>;
  /** The body is refused when it is (or announces itself as) larger; reading stops at the limit. */
  maxBytes: number;
  /** Idle time on the connection. */
  timeoutMs: number;
  /** The whole request, headers to last byte; none when omitted. */
  deadlineMs?: number;
  /** Error texts: what the caller's file is called. */
  messages: { tooLarge: string; timeout: string; failed: string };
  /**
   * A connection pool that is used for this one checked address only (the caller creates it for `pinned` and
   * closes it). Without it every request opens a fresh connection: a pooled socket could belong to another resolution.
   */
  agent?: HttpsAgent;
}

export interface PinnedBytesResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

/**
 * One HTTPS GET to `url` that connects only to `pinned` (no second DNS lookup; TLS still verifies the host name),
 * checks the connected peer address again, never follows a redirect and never reads more than `maxBytes`.
 */
export function pinnedHttpsRequest(url: URL, pinned: ResolvedHost, options: PinnedRequestOptions): Promise<PinnedBytesResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const finish = (error: Error | null, value?: PinnedBytesResponse) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      if (error) reject(error); else resolve(value!);
    };
    const request = httpsRequest(url, {
      method: 'GET',
      agent: options.agent ?? false,
      lookup: pinnedLookup(pinned),
      ...(isIP(url.hostname.replace(/^\[|\]$/g, '')) ? {} : { servername: url.hostname }),
      headers: options.headers,
    }, (response) => {
      const peer = response.socket.remoteAddress ?? '';
      if (peer !== pinned.address || blockedAddress(peer)) {
        request.destroy();
        finish(new UrlAppError('The server connection did not go to the checked address'));
        return;
      }
      const declared = Number(response.headers['content-length'] ?? '0');
      if (declared > options.maxBytes) {
        request.destroy();
        finish(new UrlAppError(options.messages.tooLarge));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > options.maxBytes) {
          request.destroy();
          finish(new UrlAppError(options.messages.tooLarge));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => finish(null, { status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }));
      response.on('error', (error) => finish(error));
    });
    request.setTimeout(options.timeoutMs, () => request.destroy(new UrlAppError(options.messages.timeout)));
    if (options.deadlineMs) deadline = setTimeout(() => request.destroy(new UrlAppError(options.messages.timeout)), options.deadlineMs);
    request.on('error', (error) => finish(error instanceof UrlAppError ? error : new UrlAppError(options.messages.failed)));
    request.end();
  });
}

const pinnedHttpsGet: PinnedGet = async (url, pinned, deadlineMs = URL_APP_FILE_DEADLINE_MS) => {
  const response = await pinnedHttpsRequest(url, pinned, {
    headers: { Accept: 'text/yaml, application/yaml, text/plain, */*', 'User-Agent': 'YouEye-Market/1.0' },
    maxBytes: MAX_DOCUMENT_BYTES,
    timeoutMs: FETCH_TIMEOUT_MS,
    deadlineMs: Math.max(1, Math.min(deadlineMs, URL_APP_FILE_DEADLINE_MS)),
    messages: {
      tooLarge: 'A manifest file exceeds the 1 MiB limit',
      timeout: 'Request timed out (the server was silent for 5 s, or the file took longer than 20 s)',
      failed: 'Failed to fetch the app manifest',
    },
  });
  return { status: response.status, contentType: String(response.headers['content-type'] ?? ''), body: response.body.toString('utf8') };
};

export interface UrlFetchDeps {
  resolve: Resolver;
  get: PinnedGet;
  /** Tests: other times than `URL_APP_FILE_DEADLINE_MS` and `URL_APP_DEADLINE_MS`. */
  fileDeadlineMs?: number;
  deadlineMs?: number;
}

const defaultDeps: UrlFetchDeps = { resolve: systemResolver, get: pinnedHttpsGet };

/** `work`, or a `UrlAppError` once `ms` have passed (whatever the resolver or the transport does). */
function inTime<T>(work: Promise<T>, ms: number): Promise<T> {
  work.catch(() => {});
  if (!(ms > 0)) return Promise.reject(new UrlAppError(TOO_SLOW));
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new UrlAppError(TOO_SLOW)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/** One file; null when the server says it does not exist (404). `deadlineAt` is when the whole app must have arrived. */
async function fetchText(url: string, required: boolean, deps: UrlFetchDeps, deadlineAt: number): Promise<string | null> {
  const problem = validateAppUrl(url);
  if (problem) throw new UrlAppError(problem);
  const parsed = new URL(url);
  const left = Math.min(deps.fileDeadlineMs ?? URL_APP_FILE_DEADLINE_MS, deadlineAt - Date.now());
  const response = await inTime((async () => {
    const pinned = await resolvePublicHost(parsed.hostname, deps.resolve);
    return deps.get(parsed, pinned, left);
  })(), left);
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
  const deadlineAt = Date.now() + (deps.deadlineMs ?? URL_APP_DEADLINE_MS);
  const manifest = await fetchText(manifestUrl, true, deps, deadlineAt);
  if (!manifest) throw new UrlAppError('The app manifest is empty');
  try {
    return await fetchApp(manifest, (name) => fetchText(new URL(name, manifestUrl).toString(), false, deps, deadlineAt));
  } catch (error) {
    if (error instanceof UrlAppError) throw error;
    const issues = (error as { issues?: string[] }).issues;
    throw new UrlAppError('Invalid app manifest', issues ?? [error instanceof Error ? error.message : String(error)]);
  }
}
