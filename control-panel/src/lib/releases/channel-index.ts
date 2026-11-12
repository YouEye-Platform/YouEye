import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { parseReleaseVersion } from '../version';
import { SpineAPIError, spineClient } from '../spine/client';
import { releaseCacheFetch } from './cache';
import { canonicalReleaseRepository, uniqueJSON, validReleaseTag } from './core-release';
import { loadProductBlob, productBlobWithinLimit, productAssetURL, verifyProductRelease, type VerifiedProductRelease } from './product-release';

/**
 * The box's channel index (`youeye.channel.v1`) names the current release of
 * every product on its channel. The Control Panel gets it from Spine (which
 * downloads and caches it) and resolves native apps, Pointer and the official
 * Market catalog through it. Documents and assets are then plain HTTPS
 * downloads of `<repository>/releases/download/<tag>/<name>`, each checked by
 * SHA-256. No release-listing API is ever called.
 */

export const RELEASE_CHANNELS = ['dev', 'alpha', 'beta', 'stable'] as const;
export type ReleaseChannelName = (typeof RELEASE_CHANNELS)[number];
export const isReleaseChannel = (value: unknown): value is ReleaseChannelName =>
  typeof value === 'string' && (RELEASE_CHANNELS as readonly string[]).includes(value);

export const INDEX_PRODUCTS = ['youeye', 'pointer', 'market', 'notes', 'wiki', 'search', 'translate', 'weather', 'cinema'] as const;

/**
 * `version` is the release name (display and tag); `build` is the build
 * version it carries (core: the document's `build`; products: the build
 * manifest's `build_version`). Only `build` orders entries.
 */
export type ChannelEntry = { repository: string; tag: string; version: string; build: string; document: string; sha256: string };
export type ChannelIndex = { schema: 'youeye.channel.v1'; channel: ReleaseChannelName; published_at: string; products: Record<string, ChannelEntry> };
export type BoxChannelIndex = { repository: string; channel: ReleaseChannelName; index: ChannelIndex; indexSHA256: string };

const RATE_LIMITED = 'release host refused or rate-limited the request, retrying';

/** HTTP 403/429 from a release host (or Spine's `rate_limited`). Never a network failure. */
export class ReleaseHostRateLimited extends Error {
  override name = 'ReleaseHostRateLimited';
  constructor(detail?: string) { super(detail ? `${RATE_LIMITED} (${detail})` : RATE_LIMITED); }
}
export class ReleaseFileNotFound extends Error { override name = 'ReleaseFileNotFound'; }

/** Classify a non-200 answer from a release host. */
export function releaseHTTPError(status: number, url: string): Error {
  const host = (() => { try { return new URL(url).host; } catch { return url; } })();
  if (status === 403 || status === 429) return new ReleaseHostRateLimited(`HTTP ${status} from ${host}`);
  if (status === 404) return new ReleaseFileNotFound(`Release file not found: ${url}`);
  return new Error(`Release host ${host} returned HTTP ${status}`);
}

export function isReleaseRateLimited(error: unknown): boolean {
  return error instanceof ReleaseHostRateLimited
    || error instanceof SpineAPIError && error.code === 'rate_limited';
}

/** Short user-facing text for a release lookup failure. */
export function describeReleaseError(error: unknown): string {
  if (isReleaseRateLimited(error)) return RATE_LIMITED;
  return error instanceof Error ? error.message : String(error);
}

function fields(value: unknown, allowed: string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k))) throw new Error('Unsupported channel index fields');
}

/** Validate an index exactly as Spine does (releasecache.ParseChannelIndex). */
export function parseChannelIndex(value: unknown): ChannelIndex {
  fields(value, ['schema', 'channel', 'published_at', 'products']);
  const index = value as ChannelIndex;
  if (index.schema !== 'youeye.channel.v1' || !isReleaseChannel(index.channel) || typeof index.published_at !== 'string' || Number.isNaN(Date.parse(index.published_at))) {
    throw new Error('Unsupported channel index');
  }
  fields(index.products, [...INDEX_PRODUCTS]);
  for (const [product, entry] of Object.entries(index.products)) {
    fields(entry, ['repository', 'tag', 'version', 'build', 'document', 'sha256']);
    let repository = '';
    try { repository = canonicalReleaseRepository(entry.repository); } catch { /* reported below */ }
    if (repository !== entry.repository || !parseReleaseVersion(entry.version) || typeof entry.build !== 'string' || !parseReleaseVersion(entry.build) || !validReleaseTag(entry.tag) || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
      throw new Error(`Channel index entry ${product} is invalid`);
    }
    const [tag, documentName] = product === 'youeye' ? [`youeye-v${entry.version}`, 'core-release.json']
      : product === 'market' ? [`catalog-v${entry.version}`, 'product-release.json']
      : [`v${entry.version}`, 'product-release.json'];
    if (entry.tag !== tag || entry.document !== documentName) throw new Error(`Channel index entry ${product} must name ${tag}/${documentName}`);
  }
  return index;
}

export function parseChannelIndexBytes(raw: Buffer): ChannelIndex {
  if (!raw.length || raw.length > 256 * 1024) throw new Error('Channel index size is invalid');
  uniqueJSON(raw.toString('utf8'));
  return parseChannelIndex(JSON.parse(raw.toString('utf8')));
}

export interface ReleaseIndexClient {
  getReleaseIndex(): Promise<{ repository: string; channel: string; index: unknown; index_sha256: string }>;
}

/** The index of the box's channel, through Spine. */
export async function readChannelIndex(client: ReleaseIndexClient = spineClient): Promise<BoxChannelIndex> {
  let answer;
  try { answer = await client.getReleaseIndex(); }
  catch (error) {
    if (isReleaseRateLimited(error)) throw new ReleaseHostRateLimited((error as Error).message);
    throw error;
  }
  const index = parseChannelIndex(answer.index);
  if (!isReleaseChannel(answer.channel) || index.channel !== answer.channel) throw new Error('Spine returned an index for another channel');
  if (!/^[0-9a-f]{64}$/.test(answer.index_sha256)) throw new Error('Spine returned no index digest');
  return { repository: canonicalReleaseRepository(answer.repository), channel: answer.channel, index, indexSHA256: answer.index_sha256 };
}

/** Release-listing APIs are never a box path. Refuse them even if a URL is constructed by mistake. */
export function assertReleaseDownloadURL(url: string): URL {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('Release downloads must be exact HTTPS URLs');
  if (/^api\./.test(parsed.hostname) || /\/api\/v\d+\/repos\//.test(parsed.pathname)) throw new Error('Release-listing APIs are not used');
  return parsed;
}

const GITHUB_ASSET_ORIGINS = new Set(['https://release-assets.githubusercontent.com', 'https://objects.githubusercontent.com']);
function redirectAllowed(from: URL, to: URL): boolean {
  if (to.protocol !== 'https:' || to.username || to.password || to.hash) return false;
  if (to.origin === from.origin) return true;
  // GitHub serves release assets from its asset CDN.
  return from.origin === 'https://github.com' && GITHUB_ASSET_ORIGINS.has(to.origin);
}

/**
 * Back-off per release host after 403/429: 30 s, 60 s, 120 s, … capped at
 * 10 minutes. While it lasts, downloads from that host are not attempted and
 * report rate limiting again; the next successful download clears it.
 */
const backoff = new Map<string, { until: number; delay: number }>();
const FIRST_BACKOFF_MS = 30_000, MAX_BACKOFF_MS = 10 * 60_000;
export function resetReleaseHostBackoff(): void { backoff.clear(); }
function rateLimited(host: string, status: number): Error {
  const delay = Math.min((backoff.get(host)?.delay ?? FIRST_BACKOFF_MS / 2) * 2, MAX_BACKOFF_MS);
  backoff.set(host, { until: Date.now() + delay, delay });
  return new ReleaseHostRateLimited(`HTTP ${status} from ${host}; next attempt in ${Math.round(delay / 1000)} s`);
}

/**
 * Download one release file with a size limit. 403/429 → ReleaseHostRateLimited
 * (with back-off), 404 → ReleaseFileNotFound. The caller verifies the digest.
 */
async function openReleaseDownload(url: string, maximumBytes: number, fetchImpl: typeof fetch, timeoutMs: number): Promise<ReadableStream<Uint8Array>> {
  const initial = assertReleaseDownloadURL(url);
  const waiting = backoff.get(initial.host);
  if (waiting && Date.now() < waiting.until) {
    throw new ReleaseHostRateLimited(`${initial.host}; next attempt in ${Math.ceil((waiting.until - Date.now()) / 1000)} s`);
  }
  let current = initial;
  let response: Response | null = null;
  for (let redirects = 0; ; redirects += 1) {
    response = await fetchImpl(current.toString(), {
      headers: { Accept: 'application/octet-stream', 'User-Agent': 'youeye-control' },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status < 300 || response.status >= 400) break;
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location || redirects >= 5) throw new Error('Release download redirect chain is invalid');
    const next = new URL(location, current);
    if (!redirectAllowed(initial, next)) throw new Error('Release download redirected outside its release host');
    current = next;
  }
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 403 || response.status === 429) throw rateLimited(initial.host, response.status);
    throw releaseHTTPError(response.status, url);
  }
  backoff.delete(initial.host);
  if ((response.headers.get('content-type') || '').toLowerCase().includes('text/html')) throw new Error(`Release file ${url} returned an HTML page`);
  const declared = Number(response.headers.get('content-length') || '0');
  if (declared > maximumBytes) throw new Error(`Release file ${url} exceeds ${maximumBytes} bytes`);
  if (!response.body) throw new Error(`Release file ${url} has no body`);
  return response.body;
}

export async function downloadReleaseFile(url: string, maximumBytes: number, fetchImpl: typeof fetch = releaseCacheFetch, timeoutMs = 120_000): Promise<Buffer> {
  const body = await openReleaseDownload(url, maximumBytes, fetchImpl, timeoutMs);
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) { await reader.cancel(); throw new Error(`Release file ${url} exceeds ${maximumBytes} bytes`); }
    chunks.push(Buffer.from(value));
  }
  if (!total) throw new Error(`Release file ${url} is empty`);
  return Buffer.concat(chunks, total);
}

export function channelEntryDocumentURL(entry: ChannelEntry): string {
  return `${entry.repository}/releases/download/${encodeURIComponent(entry.tag)}/${encodeURIComponent(entry.document)}`;
}

export type ProductResolver = {
  index?: () => Promise<BoxChannelIndex>;
  fetch?: typeof fetch;
};

/**
 * Resolve a product of the box's channel: download its release document,
 * check the index digest, then parse and bind it to the entry's repository
 * and tag. Null when the channel has no release of this product yet.
 */
export async function resolveChannelProduct(product: string, options: ProductResolver = {}): Promise<VerifiedProductRelease | null> {
  if (product === 'youeye' || !(INDEX_PRODUCTS as readonly string[]).includes(product)) throw new Error(`${product} is not a channel product`);
  const box = await (options.index ?? readChannelIndex)();
  const entry = box.index.products[product];
  if (!entry) return null;
  const raw = await downloadReleaseFile(channelEntryDocumentURL(entry), 1024 * 1024, options.fetch);
  if (createHash('sha256').update(raw).digest('hex') !== entry.sha256) throw new Error(`${entry.document} of ${entry.tag} differs from the channel index digest`);
  const selected = verifyProductRelease(raw, { product, repository: entry.repository, tag: entry.tag });
  if (selected.release.version !== entry.version || selected.build.build_version !== entry.build) throw new Error(`${product} release differs from its channel index version`);
  return selected;
}

/**
 * Stream one release file to a new local file, counting and hashing on the way,
 * so memory use stays bounded whatever the file's size. The caller checks the
 * returned size and digest. A large file gets time in proportion to its size
 * (at least 256 KiB/s) on top of the usual two minutes.
 */
export async function downloadReleaseFileTo(url: string, path: string, maximumBytes: number,
  fetchImpl: typeof fetch = releaseCacheFetch,
  timeoutMs = 120_000 + Math.ceil(maximumBytes / (256 * 1024)) * 1000): Promise<{ bytes: number; sha256: string }> {
  const body = await openReleaseDownload(url, maximumBytes, fetchImpl, timeoutMs);
  const hash = createHash('sha256');
  let total = 0;
  const counted = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      total += chunk.byteLength;
      if (total > maximumBytes) { done(new Error(`Release file ${url} exceeds ${maximumBytes} bytes`)); return; }
      hash.update(chunk);
      done(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(body as NodeReadableStream<Uint8Array>), counted, createWriteStream(path, { flags: 'wx', mode: 0o600 }));
  if (!total) throw new Error(`Release file ${url} is empty`);
  return { bytes: total, sha256: hash.digest('hex') };
}

/** Download one asset of a verified product release (digest and size checked). */
export function downloadProductAsset(selected: VerifiedProductRelease, name: string, maximumBytes = 1024 * 1024, fetchImpl?: typeof fetch): Promise<Buffer> {
  return loadProductBlob(selected, name, (url, max) => downloadReleaseFile(url, max, fetchImpl), maximumBytes);
}

/**
 * Download one large asset of a verified product release straight to `path`
 * (a new file), checking its size and digest without holding it in memory.
 */
export async function downloadProductAssetTo(selected: VerifiedProductRelease, name: string, path: string, maximumBytes: number, fetchImpl?: typeof fetch): Promise<number> {
  const blob = productBlobWithinLimit(selected, name, maximumBytes);
  const written = await downloadReleaseFileTo(productAssetURL(selected, blob), path, blob.size_bytes, fetchImpl);
  if (written.bytes !== blob.size_bytes || written.sha256 !== blob.sha256) throw new Error('Product artifact differs from its original build digest');
  return written.bytes;
}
