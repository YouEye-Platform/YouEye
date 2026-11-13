import { officialCatalogFile, readAcceptedCatalog, refreshOfficialCatalog } from './catalog-release';
import { nativeManifestFromRelease, resolveNativeProduct } from './native-artifact';
import { describeReleaseError } from '../releases/channel-index';
import { releaseCacheFetch } from '../releases/cache';
import { loadCatalogEntries, type CatalogWarning } from './partial-catalog';
/**
 * Catalog fetcher — reads apps from the Market sources.
 *
 * Layout of a Market source (docs/app-manifest.md):
 *   catalog.yaml                       youeye.catalog.v1: categories, curation, `native: [ids]`
 *   apps/<id>/youeye-app.yaml          a container app (+ setup/*.yaml, icons, screenshots)
 *   bundles/<id>/bundle.yaml           youeye.bundle.v1
 *   system/<id>.yaml                   youeye.system-app.v1
 *
 * - The official Market is the `market` product of the box's channel index; every file comes
 *   from its accepted `catalog.tar` (see catalog-release.ts) and the app list is discovered
 *   from its folders. Native apps listed in `native:` come from their own product releases on
 *   the same channel (`youeye-app.yaml` asset).
 * - Custom sources added by URL are read as raw files from their branch. They cannot list
 *   folders, so their generated `catalog.json` (youeye.catalog-index.v1) names the ids.
 */

import { readFile, writeFile, mkdir, rename } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { fetchApp, loadApp } from './app-format/compile';
import { parseBundle, parseCatalog, parseCatalogIndex, parseSystemApp, readYAML } from './app-format/parse';
import { manifestDigest } from './app-format/digest';
import type { AppManifest, Catalog, CatalogEntry, MarketApp, MarketBundle, MarketCategory, MarketCuration, SystemAppManifest } from './types';
import { buildMarketRawURL, getMarketSource, getMarketSources, isChannelMarketSource, OFFICIAL_MARKET_SOURCE_ID, recordMarketSourceResolution, type MarketSource } from './source';

const CATALOG_CACHE_DIR = '/var/lib/youeye';
const CATALOG_CACHE_PATH = path.join(CATALOG_CACHE_DIR, 'catalog-cache.json');

const DEFAULT_BRANCH = 'main';
const proxyImageUrl = (url: string) => `/api/market/image?url=${encodeURIComponent(url)}`;
const catalogImageUrl = (filePath: string) => `/api/market/image?catalog=${encodeURIComponent(filePath)}`;

export interface ManifestReference {
  path: string;
  repo: string;
  branch: string;
  digest: string;
  /** Native channel products only: the build version of the release (orders updates). */
  build?: string;
}

export interface ManifestFetchResult {
  manifest: AppManifest;
  reference: ManifestReference;
}

export interface ResolvedCatalogApp extends ManifestFetchResult {
  source: MarketSource;
  entry: CatalogEntry;
  configuredSourceRepoUrls: string[];
}

export interface SystemManifestFetchResult {
  manifest: SystemAppManifest;
  reference: ManifestReference;
}

// ─── File Fetching ────────────────────────────────────────

/** The ref a source's own files are read at: a custom source's branch; the official catalog has none. */
export function sourceRef(source: MarketSource): string {
  return isChannelMarketSource(source) ? '' : source.branch || DEFAULT_BRANCH;
}

/** One file of a Market source: from the accepted catalog.tar, or a custom source's branch. */
export async function fetchFile(filePath: string, marketSource?: MarketSource): Promise<string> {
  const source = marketSource || await getMarketSource();
  if (isChannelMarketSource(source)) return (await officialCatalogFile(filePath)).toString('utf8');
  return fetchRepoFile(source.organization, source.repository, filePath, sourceRef(source), source);
}

/** One file of a Market source, or null when it does not exist. */
async function fetchOptionalFile(filePath: string, source: MarketSource): Promise<string | null> {
  if (isChannelMarketSource(source)) {
    const accepted = await readAcceptedCatalog() ?? await refreshOfficialCatalog();
    return accepted.files.get(filePath)?.toString('utf8') ?? null;
  }
  const url = buildMarketRawURL(source, source.organization, source.repository, filePath, sourceRef(source));
  const res = await releaseCacheFetch(url, { signal: AbortSignal.timeout(15_000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Failed to fetch ${source.organization}/${source.repository}/${filePath}: ${res.status}`);
  return res.text();
}

/** A raw file of a repository on a custom source's host. */
export async function fetchRepoFile(owner: string, repo: string, filePath: string, branch: string, source: MarketSource): Promise<string> {
  const url = buildMarketRawURL(source, owner, repo, filePath, branch);
  const res = await releaseCacheFetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Failed to fetch ${owner}/${repo}/${filePath}: ${res.status}`);
  return res.text();
}

// ─── Catalog ──────────────────────────────────────────────

let catalogCache: Catalog | null = null;
let catalogCacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000;

const manifestCache = new Map<string, { manifest: AppManifest; reference?: ManifestReference; fetchedAt: number }>();

/**
 * Build a source's catalog from `catalog.yaml` and the ids found in its folders
 * (`apps/<id>/youeye-app.yaml`, `bundles/<id>/bundle.yaml`, `system/<id>.yaml`).
 */
export function catalogFromFiles(catalogYaml: string, files: Iterable<string>): Catalog {
  const document = parseCatalog(catalogYaml);
  const apps: CatalogEntry[] = [];
  const bundles: string[] = [];
  const system: string[] = [];
  for (const file of files) {
    let match = /^apps\/([a-z][a-z0-9-]{0,31})\/youeye-app\.yaml$/.exec(file);
    if (match) { apps.push({ id: match[1], integration: 'basic', path: `apps/${match[1]}` }); continue; }
    match = /^bundles\/([a-z][a-z0-9-]{0,31})\/bundle\.yaml$/.exec(file);
    if (match) { bundles.push(match[1]); continue; }
    match = /^system\/([a-z][a-z0-9-]{0,31})\.yaml$/.exec(file);
    if (match) system.push(match[1]);
  }
  for (const id of document.native ?? []) {
    if (apps.some((app) => app.id === id)) throw new Error(`catalog.yaml lists native app "${id}" that also has an app folder`);
    apps.push({ id, integration: 'native' });
  }
  const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
  return {
    apps: apps.sort(byId),
    bundles: bundles.sort(),
    system: system.sort(),
    categories: (document.categories ?? []).map((category) => ({ ...category })),
    curation: document.curation ? {
      spotlight: document.curation.spotlight
        ? { title: document.curation.spotlight.title, apps: [...document.curation.spotlight.apps] } : undefined,
      collections: (document.curation.collections ?? []).map((collection) => ({ ...collection, apps: [...collection.apps] })),
    } : undefined,
  };
}

/** A custom source: `catalog.yaml` plus its generated `catalog.json` index of folder ids. */
function catalogFromIndex(catalogYaml: string, indexJson: string): Catalog {
  const index = parseCatalogIndex(indexJson);
  return catalogFromFiles(catalogYaml, [
    ...index.apps.map((id) => `apps/${id}/youeye-app.yaml`),
    ...(index.bundles ?? []).map((id) => `bundles/${id}/bundle.yaml`),
    ...(index.system ?? []).map((id) => `system/${id}.yaml`),
  ]);
}

function acceptedCatalog(accepted: { files: Map<string, Buffer> }): Catalog {
  const catalogYaml = accepted.files.get('catalog.yaml');
  if (!catalogYaml) throw new Error('The Market catalog has no catalog.yaml');
  return catalogFromFiles(catalogYaml.toString('utf8'), accepted.files.keys());
}

export async function fetchCatalog(marketSource?: MarketSource): Promise<Catalog> {
  if (marketSource) {
    return fetchValidatedSourceCatalog(marketSource);
  }

  if (catalogCache && Date.now() - catalogCacheTime < CACHE_TTL) {
    return catalogCache;
  }

  try {
    const source = await getMarketSource();
    catalogCache = await fetchValidatedSourceCatalog(source);
    catalogCacheTime = Date.now();
    saveCatalogToFile(catalogCache).catch(() => {});
    return catalogCache;
  } catch (err) {
    const cached = await loadCatalogFromFile();
    if (cached) {
      catalogCache = cached.catalog;
      catalogCacheTime = Date.now();
      return catalogCache;
    }
    throw err;
  }
}

async function fetchValidatedSourceCatalog(source: MarketSource): Promise<Catalog> {
  if (isChannelMarketSource(source)) {
    try {
      const accepted = await refreshOfficialCatalog();
      source.refresh_error = undefined;
      await recordMarketSourceResolution(source.id, { ok: true }).catch(() => {});
      return acceptedCatalog(accepted);
    } catch (error) {
      const message = describeReleaseError(error);
      source.refresh_error = message;
      await recordMarketSourceResolution(source.id, { error: message }).catch(() => {});
      const accepted = await readAcceptedCatalog().catch(() => null);
      if (accepted) return acceptedCatalog(accepted);
      throw error;
    }
  }
  try {
    const catalog = catalogFromIndex(await fetchFile('catalog.yaml', source), await fetchFile('catalog.json', source));
    source.refresh_error = undefined;
    await recordMarketSourceResolution(source.id, { ok: true }).catch(() => {});
    return catalog;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Market refresh failed';
    source.refresh_error = message;
    await recordMarketSourceResolution(source.id, { error: message }).catch(() => {});
    throw error;
  }
}

// ─── Manifest Fetching ────────────────────────────────────

/** Fetch an app by id from the default Market source. */
export async function fetchManifest(appId: string): Promise<AppManifest> {
  const cached = manifestCache.get(appId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
    return cached.manifest;
  }

  const catalog = await fetchCatalog();
  const source = await getMarketSource();
  const entry = catalog.apps.find(e => e.id === appId);

  if (!entry) throw new Error(`App "${appId}" not found in catalog`);

  const result = await fetchManifestFromCatalogEntry(entry, source);

  manifestCache.set(appId, { manifest: result.manifest, reference: result.reference, fetchedAt: Date.now() });
  return result.manifest;
}

/**
 * Fetch a manifest from a specific Market source.
 * Used when duplicate app IDs exist across sources and install/update must
 * follow the exact source selected by the user.
 */
export async function fetchManifestFromSource(appId: string, sourceId?: string): Promise<AppManifest> {
  if (!sourceId) return fetchManifest(appId);

  const sources = await getMarketSources();
  const source = sources.find((s) => s.id === sourceId);
  if (!source) throw new Error(`Market source "${sourceId}" not found`);

  const cacheKey = `${source.id}:app:${appId}`;
  const cached = manifestCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
    return cached.manifest;
  }

  const catalog = await fetchCatalog(source);
  const entry = catalog.apps.find((e) => e.id === appId);
  if (!entry) throw new Error(`App "${appId}" not found in Market source "${sourceId}"`);

  const result = await fetchManifestFromCatalogEntry(entry, source);
  manifestCache.set(cacheKey, { manifest: result.manifest, reference: result.reference, fetchedAt: Date.now() });
  return result.manifest;
}

/**
 * Resolve an app against the exact recorded Market source identity. When old
 * installed-apps and install.json records disagree, try each recorded source
 * in order and keep the first pair that actually contains the app. Never fall
 * back to an unrelated source after an explicit recorded identity is present.
 */
export async function resolveCatalogApp(
  appId: string,
  sourceIds: Array<string | null | undefined> = [],
): Promise<ResolvedCatalogApp> {
  const requestedSourceIds = sourceIds
    .map((sourceId) => sourceId?.trim())
    .filter((sourceId, index): sourceId is string => (
      !!sourceId && sourceIds.findIndex((candidate) => candidate?.trim() === sourceId) === index
    ));
  const configuredSources = await getMarketSources();
  const sources = configuredSources.length > 0
    ? configuredSources
    : [await getMarketSource()];
  const candidates = requestedSourceIds.length > 0
    ? requestedSourceIds
    : [sources[0].id];
  const failures: string[] = [];

  for (const sourceId of candidates) {
    const source = sources.find((candidate) => candidate.id === sourceId);
    if (!source) {
      failures.push(`${sourceId}: source is not configured or enabled`);
      continue;
    }

    let catalog: Catalog;
    try {
      catalog = await fetchCatalog(source);
    } catch {
      failures.push(`${sourceId}: catalog could not be loaded`);
      continue;
    }

    const entry = catalog.apps.find((candidate) => candidate.id === appId);
    if (!entry) {
      failures.push(`${sourceId}: app is not present`);
      continue;
    }

    let result: ManifestFetchResult;
    try {
      result = await fetchManifestFromCatalogEntry(entry, source);
    } catch {
      failures.push(`${sourceId}: app manifest could not be loaded`);
      continue;
    }
    manifestCache.set(`${source.id}:app:${appId}`, {
      manifest: result.manifest,
      reference: result.reference,
      fetchedAt: Date.now(),
    });
    return {
      source,
      entry,
      configuredSourceRepoUrls: sources.map((candidate) => candidate.repo_url).filter(Boolean),
      ...result,
    };
  }

  throw new Error(
    `App "${appId}" could not be resolved from its recorded Market source (${failures.join('; ')})`,
  );
}

export async function fetchManifestReferenceFromSource(appId: string, sourceId?: string): Promise<ManifestReference> {
  const source = sourceId
    ? (await getMarketSources()).find((s) => s.id === sourceId)
    : await getMarketSource();
  if (!source) throw new Error(`Market source "${sourceId}" not found`);

  const catalog = await fetchCatalog(source);
  const entry = catalog.apps.find((e) => e.id === appId);
  if (!entry) throw new Error(`App "${appId}" not found in Market source "${source.id}"`);

  return (await fetchManifestFromCatalogEntry(entry, source)).reference;
}

type FileLocation = { owner: string; repo: string; ref: string } | null;

/** Where a source's own files live: the official catalog.tar (null) or a custom repository at its branch. */
function sourceLocation(source: MarketSource): FileLocation {
  return isChannelMarketSource(source) ? null : { owner: source.organization, repo: source.repository, ref: sourceRef(source) };
}

/** The setup files in an app folder of the official catalog.tar (it can be listed). */
async function officialSetupFiles(appPath: string): Promise<Record<string, string>> {
  const accepted = await readAcceptedCatalog() ?? await refreshOfficialCatalog();
  const prefix = `${appPath}/setup/`;
  const setups: Record<string, string> = {};
  for (const [name, bytes] of accepted.files) {
    if (name.startsWith(prefix)) setups[name.slice(appPath.length + 1)] = bytes.toString('utf8');
  }
  return setups;
}

async function fetchManifestFromCatalogEntry(
  entry: CatalogEntry,
  source: MarketSource
): Promise<ManifestFetchResult> {
  // Native apps name a product of the box's channel index.
  if (entry.integration === 'native') {
    const selected = await resolveNativeProduct(entry.id);
    const { manifest } = await nativeManifestFromRelease(selected);
    return {
      manifest,
      reference: { path: 'youeye-app.yaml', repo: selected.repository, branch: selected.release.tag, digest: manifest.frozen!.digest, build: selected.build.build_version },
    };
  }
  if (!entry.path) throw new Error(`Catalog entry "${entry.id}" has no app folder`);

  const location = sourceLocation(source);
  const manifestPath = `${entry.path}/youeye-app.yaml`;
  const text = await fetchFile(manifestPath, source);
  let manifest: AppManifest;
  if (isChannelMarketSource(source)) {
    // Every file under setup/ is passed: files the app does not name are refused.
    manifest = loadApp({ manifest: text, setups: await officialSetupFiles(entry.path) });
  } else {
    manifest = await fetchApp(text, (name) => fetchOptionalFile(`${entry.path}/${name}`, source));
  }
  if (manifest.metadata.id !== entry.id) {
    throw new Error(`App folder "${entry.path}" holds app "${manifest.metadata.id}"`);
  }

  await resolveManifestPaths(manifest, source, location, entry.path);
  return {
    manifest,
    reference: {
      path: manifestPath,
      repo: location ? `${location.owner}/${location.repo}` : 'official',
      branch: location?.ref ?? '',
      digest: manifest.frozen!.digest,
    },
  };
}

async function fetchSystemManifest(id: string, source: MarketSource): Promise<SystemManifestFetchResult> {
  const filePath = `system/${id}.yaml`;
  const text = await fetchFile(filePath, source);
  const document = parseSystemApp(text);
  if (document.id !== id) {
    throw new Error(`System manifest "${filePath}" holds "${document.id}"`);
  }
  const location = sourceLocation(source);
  return {
    manifest: {
      id: document.id,
      version: document.version,
      name: document.name,
      image: document.image,
      health: typeof document.health === 'string' ? document.health : document.health?.path,
    },
    reference: {
      path: filePath,
      repo: location ? `${location.owner}/${location.repo}` : 'official',
      branch: location?.ref ?? '',
      digest: manifestDigest(readYAML(text)),
    },
  };
}

// ─── Image Proxy ──────────────────────────────────────────

/** Point the listing icon and screenshots (files in the app folder) at the image proxy. */
export async function resolveManifestPaths(
  manifest: AppManifest,
  source: MarketSource,
  location: FileLocation,
  /** App folder (e.g. `apps/redlib`); relative assets resolve under it. */
  basePath?: string
): Promise<void> {
  const relative = (asset: string) => basePath ? `${basePath.replace(/\/+$/, '')}/${asset}` : asset;
  const assetURL = (asset: string) => location
    ? proxyImageUrl(buildMarketRawURL(source, location.owner, location.repo, relative(asset), location.ref))
    : catalogImageUrl(relative(asset));

  if (manifest.metadata.iconUrl) manifest.metadata.iconUrl = assetURL(manifest.metadata.iconUrl);
  for (const screenshot of manifest.detail?.screenshots ?? []) {
    if (screenshot.path) screenshot.path = assetURL(screenshot.path);
  }
}

// ─── MarketApp Conversion ─────────────────────────────────

/** The install-time "YouEye ID sign-in" toggle of an app whose SSO needs a setup file. */
function getDisplayIntegrations(manifest: AppManifest): NonNullable<MarketApp['integrations']> {
  if (!manifest.sso || !manifest.setups.some((setup) => setup.for === 'sso')) return [];
  return [{
    id: 'youeye-id',
    name: 'Identity Sign-In',
    description: 'Configure this app to use the identity provider after the base app is installed.',
    type: 'identity',
    recommended: true,
    installByDefault: true,
    required: false,
    permissions: ['identity:oauth-client:create'],
  }];
}

export function manifestToMarketApp(manifest: AppManifest, source?: MarketSource, reference?: ManifestReference): MarketApp {
  const hasNotificationSurface = manifest.surfaces.some(
    (surface) => surface.kind === 'notification' && surface.placement === 'notification-center'
  );
  const capabilities = manifest.capabilities || hasNotificationSurface ? {
    widgets: manifest.capabilities?.widgets,
    notifications: manifest.capabilities?.notifications || (hasNotificationSurface ? true : undefined),
    smtp: manifest.capabilities?.smtp,
    ai_api: manifest.capabilities?.ai_api,
    link_handlers: manifest.capabilities?.link_handlers,
  } : undefined;

  return {
    id: manifest.metadata.id,
    catalogKey: source ? `${source.id}:app:${manifest.metadata.id}` : undefined,
    itemKind: 'app',
    sourceId: source?.id,
    sourceName: source?.name,
    sourceRepoUrl: source?.repo_url,
    manifestPath: reference?.path,
    manifestRepo: reference?.repo,
    manifestBranch: reference?.branch,
    manifestDigest: reference?.digest,
    name: manifest.metadata.name,
    description: manifest.metadata.description,
    icon: manifest.metadata.icon,
    iconUrl: manifest.metadata.iconUrl,
    category: manifest.metadata.category,
    integration: manifest.integration,
    version: manifest.version,
    requiresYouEye: manifest.requires?.youeye,
    defaultSubdomain: manifest.metadata.defaultSubdomain,
    supportsSSO: !!manifest.sso,
    website: manifest.metadata.website,
    developer: manifest.metadata.developer,
    license: manifest.metadata.license,
    sourceCode: manifest.metadata.sourceCode,
    support: manifest.metadata.support,
    docs: manifest.metadata.docs,
    tagline: manifest.metadata.tagline,
    tags: manifest.metadata.tags,
    detail: manifest.detail ? {
      longDescription: manifest.detail.longDescription,
      releaseNotes: manifest.detail.releaseNotes,
      screenshots: manifest.detail.screenshots.map((s) => ({
        url: s.path,
        caption: s.caption,
      })),
    } : undefined,
    setups: manifest.setups.map((setup) => ({ name: setup.name, for: setup.for })),
    integrations: getDisplayIntegrations(manifest),
    forwardAuth: manifest.forwardAuth,
    // Only the official catalog may default an app to public access (added sources are not reviewed).
    publicAccess: source?.id === OFFICIAL_MARKET_SOURCE_ID ? manifest.publicAccess : undefined,
    capabilities,
    surfaces: manifest.surfaces,
  };
}

function systemManifestToMarketApp(manifest: SystemAppManifest, source?: MarketSource, reference?: ManifestReference): MarketApp {
  return {
    id: manifest.id,
    catalogKey: source ? `${source.id}:system:${manifest.id}` : undefined,
    itemKind: 'system',
    sourceId: source?.id,
    sourceName: source?.name,
    sourceRepoUrl: source?.repo_url,
    manifestPath: reference?.path,
    manifestRepo: reference?.repo,
    manifestBranch: reference?.branch,
    manifestDigest: reference?.digest,
    name: manifest.name,
    description: manifest.name,
    icon: 'server',
    category: 'infrastructure',
    integration: 'basic',
    version: manifest.version,
    defaultSubdomain: '',
    supportsSSO: false,
    tags: [],
    system: {
      image: manifest.image,
      managedBy: 'control-panel',
    },
  };
}

// ─── Public API ───────────────────────────────────────────

export async function fetchAvailableApps(onWarning?: (warning: CatalogWarning) => void): Promise<MarketApp[]> {
  const sources = await getMarketSources();
  const apps: MarketApp[] = [];

  const results = await Promise.allSettled(sources.map(async (source) => {
    const catalog = await fetchCatalog(source);
    const reportFailure = (entry: { id: string }, error: unknown) => {
      console.warn(`[market] ${source.id}/${entry.id}: manifest unavailable`, error);
      onWarning?.({ sourceId: source.id, itemId: entry.id, message: `${source.name}: could not load ${entry.id}.` });
    };
    return loadCatalogEntries(catalog.apps, async (entry) => {
      const result = await fetchManifestFromCatalogEntry(entry, source);
      return manifestToMarketApp(result.manifest, source, result.reference);
    }, reportFailure);
  }));

  for (const [index, result] of results.entries()) {
    if (result.status === 'fulfilled') {
      apps.push(...result.value);
    } else {
      const source = sources[index];
      console.warn(`[market] ${source.id}: catalog unavailable`, result.reason);
      onWarning?.({ sourceId: source.id, message: `${source.name}: could not load its catalog.` });
    }
  }

  return apps;
}

/**
 * Fetch Market category metadata (pills, labels, icons, ordering, fallback tiles) from the
 * enabled sources. Categories are merged by id across sources in priority order — the first
 * source to declare a category id wins — and returned sorted by `order`.
 */
export async function fetchCategories(): Promise<MarketCategory[]> {
  const sources = await getMarketSources();
  const byId = new Map<string, MarketCategory>();
  const results = await Promise.allSettled(sources.map((source) => fetchCatalog(source)));
  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    for (const category of result.value.categories ?? []) {
      if (!byId.has(category.id)) byId.set(category.id, category);
    }
  }
  return [...byId.values()].sort(
    (a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER),
  );
}

/**
 * Fetch the Market curation (spotlight strip + collections) for the Market home. The first
 * enabled source (priority order) that declares a `curation:` section wins.
 */
export async function fetchCuration(): Promise<MarketCuration | null> {
  const sources = await getMarketSources();
  const results = await Promise.allSettled(sources.map((source) => fetchCatalog(source)));
  for (const result of results) {
    if (result.status === 'fulfilled' && result.value.curation) {
      return result.value.curation;
    }
  }
  return null;
}

/**
 * Fetch the bundle definitions (`bundles/<id>/bundle.yaml`) across enabled Market sources,
 * deduped by id in source-priority order. A bundle that fails to load is logged and skipped.
 */
export async function fetchBundles(): Promise<MarketBundle[]> {
  const sources = await getMarketSources();
  const out: MarketBundle[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    let catalog: Catalog;
    try {
      catalog = await fetchCatalog(source);
    } catch {
      continue; // a bad source must not sink bundles from the others
    }
    for (const id of catalog.bundles ?? []) {
      if (seen.has(id)) continue;
      const file = `bundles/${id}/bundle.yaml`;
      try {
        const bundle = parseBundle(await fetchFile(file, source));
        if (bundle.id !== id) throw new Error(`holds bundle "${bundle.id}"`);
        out.push({
          id: bundle.id,
          name: bundle.name,
          description: bundle.description,
          icon: bundle.icon,
          category: bundle.category,
          setupSummary: bundle.summary,
          members: [...bundle.members],
          connections: (bundle.connections ?? []).map((connection) => ({ ...connection, scope: connection.scope ?? 'service' })),
          storageGroups: [...(bundle.shared ?? [])],
        });
        seen.add(id);
      } catch (err) {
        console.error(`[catalog] Failed to load bundle "${id}" (${file}):`, err);
      }
    }
  }
  return out;
}

/** Fetch a single bundle definition by id (or null if not found in any enabled source). */
export async function fetchBundle(id: string): Promise<MarketBundle | null> {
  const bundles = await fetchBundles();
  return bundles.find((b) => b.id === id) ?? null;
}

export async function fetchAvailableSystemApps(): Promise<MarketApp[]> {
  const sources = await getMarketSources();
  const systemApps: MarketApp[] = [];

  const results = await Promise.allSettled(sources.map(async (source) => {
    const catalog = await fetchCatalog(source);
    return Promise.all((catalog.system ?? []).map(async (id) => {
      const result = await fetchSystemManifest(id, source);
      return systemManifestToMarketApp(result.manifest, source, result.reference);
    }));
  }));

  for (const result of results) {
    if (result.status === 'fulfilled') {
      systemApps.push(...result.value);
    }
  }

  return systemApps;
}

export function clearCatalogCache(): void {
  catalogCache = null;
  catalogCacheTime = 0;
  manifestCache.clear();
}

export async function refreshCatalog(): Promise<Catalog> {
  clearCatalogCache();
  return fetchCatalog();
}

export async function getCatalogCacheAge(): Promise<string | null> {
  const cache = await loadCatalogFromFile();
  if (!cache) return null;
  const ageMs = Date.now() - new Date(cache.savedAt).getTime();
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hours ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

// ─── Catalog Cache Persistence ────────────────────────────

interface CatalogCacheFile {
  catalog: Catalog;
  savedAt: string;
}

async function saveCatalogToFile(catalog: Catalog): Promise<void> {
  try {
    if (!existsSync(CATALOG_CACHE_DIR)) await mkdir(CATALOG_CACHE_DIR, { recursive: true });
    const temporary = `${CATALOG_CACHE_PATH}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(temporary, JSON.stringify({ catalog, savedAt: new Date().toISOString() }, null, 2));
    await rename(temporary, CATALOG_CACHE_PATH);
  } catch {}
}

async function loadCatalogFromFile(): Promise<CatalogCacheFile | null> {
  try {
    if (!existsSync(CATALOG_CACHE_PATH)) return null;
    const raw = await readFile(CATALOG_CACHE_PATH, 'utf-8');
    const cached = JSON.parse(raw) as CatalogCacheFile;
    // Only the current catalog shape (apps discovered from folders) is usable.
    if (!Array.isArray(cached?.catalog?.apps) || !Array.isArray(cached.catalog.bundles) || !Array.isArray(cached.catalog.system)) return null;
    return cached;
  } catch {
    return null;
  }
}
