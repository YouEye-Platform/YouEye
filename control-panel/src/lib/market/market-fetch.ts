/**
 * Fetching the files of a market (`youeye.market.v1`, market-format.ts) from its HTTPS address.
 *
 * Every market is fetched this way, the official one included. The address rules are those of
 * apps added by URL (url-app.ts, whose resolver and pinned request this module uses): HTTPS only,
 * no credentials, internal host names refused, the host resolved first and every address it
 * resolves to public, the connection made to that checked address only, the peer address checked
 * again, and no redirect ever followed.
 *
 * Bodies are bytes. Each kind of file has its limit (`MARKET_LIMITS`): a larger `content-length`
 * is refused before the body is read, and a body without one is cut at the limit. Only the paths
 * the format defines can be asked for (`marketFileURL`). The caller checks every hash.
 */

import { Agent } from 'node:https';
import { MARKET_LIMITS, MARKET_POINTER_FILE, marketFileURL, normalizeMarketAddress } from './market-format';
import {
  pinnedHttpsRequest, resolvePublicHost, validateAppUrl,
  type ResolvedHost, type Resolver,
} from './url-app';

export type MarketFileKind = keyof typeof MARKET_LIMITS;

const IDLE_TIMEOUT_MS = 10_000;
/**
 * Headers to last byte, per file. A picture may be 5 MiB on a slow line. A refresh fetches many files: the time all
 * of them may take together is the store's (`MARKET_REFRESH_DEADLINE_MS`), which closes the session when it is over.
 */
const DEADLINE_MS: Record<MarketFileKind, number> = { pointer: 20_000, index: 60_000, bundle: 30_000, file: 90_000 };
const USER_AGENT = 'YouEye-Market/1.0';

/** A market file could not be fetched (address refused, network, HTTP status, size). The message is safe to show. */
export class MarketFetchError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'MarketFetchError';
  }
}

export interface MarketGetRequest {
  headers: Record<string, string>;
  maxBytes: number;
  what: string;
  kind: MarketFileKind;
  agent?: Agent;
}

export interface MarketGetResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

/** One GET of a market file, connecting only to `pinned`. Tests replace it. */
export type MarketGet = (url: URL, pinned: ResolvedHost, request: MarketGetRequest) => Promise<MarketGetResponse>;

export interface MarketFetchDeps {
  resolve?: Resolver;
  get?: MarketGet;
}

const pinnedMarketGet: MarketGet = (url, pinned, request) => pinnedHttpsRequest(url, pinned, {
  headers: request.headers,
  maxBytes: request.maxBytes,
  timeoutMs: IDLE_TIMEOUT_MS,
  deadlineMs: DEADLINE_MS[request.kind],
  agent: request.agent,
  messages: {
    tooLarge: `${request.what} is larger than the ${request.maxBytes} bytes allowed`,
    timeout: `${request.what}: the market did not answer in time`,
    failed: `${request.what} could not be fetched`,
  },
});

export type MarketFile =
  | { status: 'ok'; bytes: Buffer; etag?: string }
  /** Only for a request that sent `etag`: the market still has that file. */
  | { status: 'not-modified' };

export interface MarketFileRequest {
  /** Sent as `If-None-Match` (market.json only). */
  etag?: string;
  /** A tighter limit than the kind's (the size the pointer or index recorded). */
  maxBytes?: number;
}

/**
 * The files of one market over one checked address. The host is resolved once, when the session
 * opens; every request of the session connects to that address and shares a small connection
 * pool, so a refresh costs one TLS handshake instead of one per file. `close()` ends the pool.
 */
export interface MarketSession {
  readonly address: string;
  get(path: string, kind: MarketFileKind, request?: MarketFileRequest): Promise<MarketFile>;
  close(): void;
}

function header(headers: MarketGetResponse['headers'], name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** Why a market at `address` (normalised) may not be fetched from, before resolving: an internal host by name or literal address. */
function marketAddressProblem(address: string): string | null {
  return validateAppUrl(address) ? 'A market address must point to a public server' : null;
}

/** Open a session on the market at `address` (any form `normalizeMarketAddress` accepts). Throws `MarketFetchError`. */
export async function openMarketSession(address: string, deps: MarketFetchDeps = {}): Promise<MarketSession> {
  let normalised: string;
  try { normalised = normalizeMarketAddress(address); }
  catch (error) { throw new MarketFetchError(error instanceof Error ? error.message : 'Invalid market address'); }
  const problem = marketAddressProblem(normalised);
  if (problem) throw new MarketFetchError(problem);
  const host = new URL(normalised).hostname;
  let pinned: ResolvedHost;
  try { pinned = await resolvePublicHost(host, deps.resolve); }
  catch (error) {
    throw new MarketFetchError((error instanceof Error ? error.message : `Could not resolve ${host}`)
      .replace(/^URL must point to a public server/, 'A market must be on a public server'));
  }
  const get = deps.get ?? pinnedMarketGet;
  // The pool belongs to this one checked address; it is never shared with another resolution.
  const agent = deps.get ? undefined : new Agent({ keepAlive: true, maxSockets: 4, maxFreeSockets: 4 });

  return {
    address: normalised,
    async get(path, kind, request = {}) {
      let url: URL;
      try { url = new URL(marketFileURL(normalised, path)); }
      catch (error) { throw new MarketFetchError(error instanceof Error ? error.message : `Not a market file path: ${path}`); }
      const what = path === MARKET_POINTER_FILE ? MARKET_POINTER_FILE : path;
      const maxBytes = Math.min(MARKET_LIMITS[kind], request.maxBytes ?? MARKET_LIMITS[kind]);
      let response: MarketGetResponse;
      try {
        response = await get(url, pinned, {
          headers: {
            Accept: kind === 'file' ? 'image/*, */*' : 'application/json, */*',
            'User-Agent': USER_AGENT,
            ...(request.etag ? { 'If-None-Match': request.etag } : {}),
          },
          maxBytes, what, kind, agent,
        });
      } catch (error) {
        throw new MarketFetchError(error instanceof Error && error.name === 'UrlAppError' ? error.message : `${what} could not be fetched`);
      }
      if (response.status === 304 && request.etag) return { status: 'not-modified' };
      if (response.status >= 300 && response.status < 400) {
        throw new MarketFetchError(`${what}: HTTP ${response.status} (a market must not redirect)`, response.status);
      }
      if (response.status !== 200) throw new MarketFetchError(`${what}: HTTP ${response.status}`, response.status);
      // The limit is enforced by the transport while reading; checked again for transports that do not.
      const declared = Number(header(response.headers, 'content-length') ?? '0');
      if (declared > maxBytes || response.body.byteLength > maxBytes) {
        throw new MarketFetchError(`${what} is larger than the ${maxBytes} bytes allowed`);
      }
      if (response.body.byteLength === 0) throw new MarketFetchError(`${what} is empty`);
      const etag = header(response.headers, 'etag');
      return { status: 'ok', bytes: response.body, ...(etag && etag.length <= 256 ? { etag } : {}) };
    },
    close() { agent?.destroy(); },
  };
}
