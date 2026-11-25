/**
 * The real Market modules over a temporary /var/lib/youeye and fake market hosts: the source list, the store, the
 * catalog reader and (with `load`) the routes and engines that use them. Nothing here reaches a network or Spine.
 */
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import * as compile from '../../src/lib/market/app-format/compile';
import * as parse from '../../src/lib/market/app-format/parse';
import * as requires from '../../src/lib/market/app-format/requires';
import * as format from '../../src/lib/market/market-format';
import * as realStore from '../../src/lib/market/market-store';
import * as partialCatalog from '../../src/lib/market/partial-catalog';
import * as publicAccess from '../../src/lib/market/public-access';
import * as sources from '../../src/lib/market/source';
import * as routing from '../../src/lib/market/update-routing';
import * as realVersion from '../../src/lib/version';
import type { AppManifest } from '../../src/lib/market/types';
import { fakeMarketHosts } from './market';

export const root = process.env.CONTROL_PANEL_ROOT || path.join(import.meta.dirname, '..', '..');
const nodeRequire = createRequire(import.meta.url);

/** Run a source file with its imports replaced. Node built-ins pass through; anything else unmocked throws on use. */
export function load(file: string, mocks: Record<string, unknown>): Record<string, any> {
  const output = ts.transpileModule(readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: file,
  }).outputText;
  const module = { exports: {} as Record<string, any> };
  new Function('require', 'exports', 'module', output)((name: string) => {
    if (name in mocks) return mocks[name];
    if (/^(node:)?(fs|fs\/promises|path|crypto)$/.test(name)) return nodeRequire(name);
    return new Proxy({}, { get: (_target, property) => {
      if (property === '__esModule') return true;
      return () => { throw new Error(`Unexpected use of ${name}.${String(property)} in ${file}`); };
    } });
  }, module.exports, module);
  return module.exports;
}

/** A temporary state directory (`YOUEYE_MARKET_STATE_DIR`) and a clean store memory for one test. */
export function withMarketState(work: (directory: string) => Promise<void>) {
  return async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'youeye-market-'));
    const previous = process.env.YOUEYE_MARKET_STATE_DIR;
    process.env.YOUEYE_MARKET_STATE_DIR = directory;
    realStore.resetMarketStoreMemory();
    try { await work(directory); }
    finally {
      if (previous === undefined) delete process.env.YOUEYE_MARKET_STATE_DIR; else process.env.YOUEYE_MARKET_STATE_DIR = previous;
      realStore.resetMarketStoreMemory();
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

export interface WorldOptions {
  /** The YouEye version of the box (`requires.youeye` is checked against it). */
  boxVersion?: string;
  /** The official Market's lane (`lane` on the official entry of market-sources.json); main when not given. */
  lane?: 'main' | 'dev';
  now?: () => number;
  /** The source module to use (a copy loaded with other installed apps); the real one by default. */
  sources?: Record<string, any>;
  /** How the fake hosts behave (`fakeMarketHosts`): a request held open, a status, other bytes. */
  hosts?: Parameters<typeof fakeMarketHosts>[1];
  /** Other store options for every call (shorter waits and deadlines). */
  store?: realStore.MarketStoreOptions;
}

/**
 * The store and the catalog reader over `sites` (market address → files). `store` is the real store with the fake
 * transport and channel filled in; `catalog` is the real catalog module over it.
 */
export function marketWorld(sites: Record<string, Map<string, Buffer>>, options: WorldOptions = {}) {
  const hosts = fakeMarketHosts(sites, options.hosts);
  if (options.lane) {
    // Written before anything reads the list (a test that writes its own list sets the lane there).
    const file = path.join(sources.marketStateDir(), 'market-sources.json');
    let list: { active_sources?: Array<Record<string, unknown>> } = {};
    try { list = JSON.parse(readFileSync(file, 'utf8')); } catch { /* no list yet */ }
    const entries = list.active_sources ?? [];
    const official = entries.find((entry) => entry.id === 'official');
    if (official) official.lane = options.lane; else entries.unshift({ id: 'official', enabled: true, lane: options.lane });
    writeFileSync(file, JSON.stringify({ ...list, active_sources: entries }));
  }
  const sourceModule = options.sources ?? sources;
  const defaults = (): realStore.MarketStoreOptions => ({
    deps: hosts.deps,
    ...(options.now ? { now: options.now } : {}),
    ...options.store,
  });
  const store = {
    ...realStore,
    currentMarket: (source: sources.MarketSource, extra: realStore.MarketStoreOptions = {}) => realStore.currentMarket(source, { ...defaults(), ...extra }),
    refreshMarket: (source: sources.MarketSource, extra: realStore.MarketStoreOptions = {}) => realStore.refreshMarket(source, { ...defaults(), ...extra }),
    refreshMarketForReader: (source: sources.MarketSource, extra: realStore.MarketStoreOptions = {}) => realStore.refreshMarketForReader(source, { ...defaults(), ...extra }),
    readMarketPicture: (source: sources.MarketSource, file: string, extra: realStore.MarketStoreOptions = {}) => realStore.readMarketPicture(source, file, { ...defaults(), ...extra }),
    readInstallIconPicture: (sourceId: string, file: string) => realStore.readInstallIconPicture(sourceId, file, defaults()),
    previewMarket: (address: string) => realStore.previewMarket(address, hosts.deps, defaults()),
  };
  const catalog = load('src/lib/market/catalog.ts', {
    './app-format/compile': compile,
    './app-format/parse': parse,
    './app-format/requires': requires,
    '../releases/channel-index': { describeReleaseError: (error: unknown) => (error instanceof Error ? error.message : String(error)) },
    './market-format': format,
    './market-store': store,
    './native-artifact': {
      // The real one, without the module's release and staging imports.
      nativePackageOf: (manifest: AppManifest) => {
        const lxd = manifest.containers.filter((container) => container.type === 'lxd');
        return lxd.length === 1 ? lxd[0].source?.package ?? null : null;
      },
    },
    '../version': realVersion,
    './partial-catalog': partialCatalog,
    './public-access': publicAccess,
    './source': sourceModule,
    './platform-env': { getPlatformContext: async () => ({ version: options.boxVersion ?? '0.6.11' }) },
  });
  return { hosts, sites, store, catalog, sources: sourceModule, routing };
}
