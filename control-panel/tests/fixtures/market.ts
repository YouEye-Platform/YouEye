/**
 * Markets for tests: files in the published format (`youeye.market.v1`), built with the format module's own
 * helpers, and a fake transport that serves them to the market fetcher (no network, every request recorded).
 */
import { stringify } from 'yaml';
import {
  MARKET_INDEX_SCHEMA, MARKET_POINTER_FILE, MARKET_SCHEMA, bundlePath, filePath, indexPath, sha256Hex,
} from '../../src/lib/market/market-format';
import type { MarketFetchDeps, MarketGet } from '../../src/lib/market/market-fetch';
import { appYAML, marketNativeYAML } from './app-format';

export const PUBLIC_ADDRESS = '93.184.216.34';
const json = (value: unknown) => Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');

export interface FixtureApp {
  id: string;
  /** `youeye-app.yaml` text; a minimal valid container app of this id and `version` when omitted. */
  manifest?: string;
  version?: string;
  /** Changes to the minimal app document (ignored when `manifest` is given). */
  changes?: Record<string, unknown>;
  /** Setup files by bare file name (`install.yaml`), as a bundle carries them. */
  setups?: Record<string, string>;
  /** Pictures by the name the manifest uses (`icon.svg`); the extension decides the hashed path. */
  pictures?: Record<string, Buffer>;
  /** Extra or replaced fields of the index entry (e.g. `kind`, `requires`). `undefined` removes one. */
  entry?: Record<string, unknown>;
  /** Replace the whole bundle document (a bundle this reader may not understand). */
  bundle?: unknown;
  /** A native app (kind `native`, `source.package`, `requires.youeye: ">=0.6.20"`; YE-142). */
  native?: boolean;
}

export interface FixtureMarket {
  name?: string;
  publisher?: string;
  sequence: number;
  commit?: string;
  apps: FixtureApp[];
  /** The `native` id list indexes carried before 0.6.20 (this reader ignores it). */
  legacyNative?: string[];
  bundles?: Array<{ id: string; members: string[] }>;
  categories?: Array<{ id: string; label: string; order?: number }>;
  /** Raw entries appended to the index's `apps` (malformed ones, to be skipped by the reader). */
  rawApps?: unknown[];
}

export interface BuiltFixture {
  /** Every file by its path in the market folder. */
  files: Map<string, Buffer>;
  pointer: Buffer;
  indexPath: string;
  bundlePaths: Record<string, string>;
  picturePaths: Record<string, Record<string, string>>;
  manifests: Record<string, string>;
}

export function buildFixtureMarket(market: FixtureMarket): BuiltFixture {
  const files = new Map<string, Buffer>();
  const bundlePaths: Record<string, string> = {};
  const picturePaths: Record<string, Record<string, string>> = {};
  const manifests: Record<string, string> = {};
  const apps: unknown[] = [];
  for (const app of market.apps) {
    const pictures: Record<string, string> = {};
    for (const [name, bytes] of Object.entries(app.pictures ?? {})) {
      const hashed = filePath(sha256Hex(bytes), name.split('.').pop()!);
      files.set(hashed, bytes);
      pictures[name] = hashed;
    }
    picturePaths[app.id] = pictures;
    const listing = { description: `${app.id} app`, category: 'utilities', icon: 'box', ...(pictures['icon.svg'] ? { icon_file: 'icon.svg' } : {}),
      ...(Object.keys(pictures).some((name) => name.startsWith('screenshots/'))
        ? { screenshots: Object.keys(pictures).filter((name) => name.startsWith('screenshots/')).map((path) => ({ path })) } : {}) };
    const manifest = app.manifest ?? (app.native ? marketNativeYAML : appYAML)({ id: app.id, name: app.id, version: app.version ?? '1.0.0', listing, ...app.changes });
    manifests[app.id] = manifest;
    const bundle = json(app.bundle ?? { manifest, setups: app.setups ?? {}, files: pictures });
    const bundleSha = sha256Hex(bundle);
    bundlePaths[app.id] = bundlePath(app.id, bundleSha);
    files.set(bundlePaths[app.id], bundle);
    const entry: Record<string, unknown> = {
      id: app.id, kind: app.native ? 'native' : 'container', name: app.id, version: app.version ?? '1.0.0', description: `${app.id} app`, category: 'utilities',
      ...(app.native ? { requires: { youeye: '>=0.6.20' } } : {}),
      ...(pictures['icon.svg'] ? { icon: pictures['icon.svg'] } : {}),
      runs_setup: Object.keys(app.setups ?? {}).length > 0,
      bundle: { path: bundlePaths[app.id], sha256: bundleSha, size: bundle.length },
      ...app.entry,
    };
    for (const key of Object.keys(entry)) if (entry[key] === undefined) delete entry[key];
    apps.push(entry);
  }
  const index = json({
    schema: MARKET_INDEX_SCHEMA,
    categories: market.categories ?? [{ id: 'utilities', label: 'Utilities', order: 1 }],
    ...(market.legacyNative ? { native: market.legacyNative } : {}),
    bundles: (market.bundles ?? []).map((bundle) => ({
      id: bundle.id,
      definition: stringify({ schema: 'youeye.bundle.v1', id: bundle.id, name: bundle.id, description: 'd', members: bundle.members }),
    })),
    apps: [...apps, ...(market.rawApps ?? [])],
  });
  const indexSha = sha256Hex(index);
  files.set(indexPath(indexSha), index);
  const pointer = json({
    schema: MARKET_SCHEMA, name: market.name ?? 'Test Market', publisher: market.publisher ?? 'Tester',
    sequence: market.sequence, ...(market.commit ? { commit: market.commit } : {}),
    index: { path: indexPath(indexSha), sha256: indexSha, size: index.length },
  });
  files.set(MARKET_POINTER_FILE, pointer);
  return { files, pointer, indexPath: indexPath(indexSha), bundlePaths, picturePaths, manifests };
}

export interface FakeRequest {
  url: string;
  address: string;
  path: string;
  pinned: string;
  ifNoneMatch?: string;
  status: number;
}

/**
 * A fake world of market hosts. `sites` maps a market address to its files (replace an entry to publish a new
 * state). Every request is recorded. `resolve` maps a host name to the addresses it resolves to (public by default).
 */
export function fakeMarketHosts(sites: Record<string, Map<string, Buffer>>, options: {
  resolve?: Record<string, string[]>;
  /** Status to answer instead of serving, by URL. */
  status?: Record<string, number>;
  /** Answer with these bytes instead of the file, by URL (a host that serves other content). */
  replace?: Record<string, Buffer>;
  /** Called before each answer (to hold a request open). */
  before?: (url: string) => Promise<void> | void;
} = {}) {
  const requests: FakeRequest[] = [];
  const state = { down: false, status: options.status ?? {}, replace: options.replace ?? {} };
  const get: MarketGet = async (url, pinned, request) => {
    const text = url.toString();
    const address = Object.keys(sites).filter((candidate) => text.startsWith(candidate)).sort((a, b) => b.length - a.length)[0] ?? '';
    const path = address ? text.slice(address.length) : url.pathname;
    const record: FakeRequest = { url: text, address, path, pinned: pinned.address, ifNoneMatch: request.headers['If-None-Match'], status: 0 };
    requests.push(record);
    await options.before?.(text);
    if (state.down) throw Object.assign(new Error(`${request.what} could not be fetched`), { name: 'UrlAppError' });
    if (state.status[text]) { record.status = state.status[text]; return { status: record.status, headers: {}, body: Buffer.alloc(0) }; }
    const bytes = state.replace[text] ?? sites[address]?.get(path);
    if (!bytes) { record.status = 404; return { status: 404, headers: {}, body: Buffer.from('not found') }; }
    const etag = `"${sha256Hex(bytes).slice(0, 16)}"`;
    if (request.headers['If-None-Match'] === etag) { record.status = 304; return { status: 304, headers: { etag }, body: Buffer.alloc(0) }; }
    record.status = 200;
    // Like the real transport: a body over the limit is never handed over.
    if (bytes.length > request.maxBytes) throw Object.assign(new Error(`${request.what} is larger than the ${request.maxBytes} bytes allowed`), { name: 'UrlAppError' });
    return { status: 200, headers: { etag, 'content-length': String(bytes.length) }, body: bytes };
  };
  const deps: MarketFetchDeps = {
    resolve: async (host) => options.resolve?.[host] ?? [PUBLIC_ADDRESS],
    get,
  };
  return {
    deps, requests, state,
    /** Paths requested since the last call (or since the start), in order. */
    take(): string[] { return requests.splice(0).map((request) => request.path); },
  };
}
