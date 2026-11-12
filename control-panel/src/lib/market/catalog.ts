import { officialCatalogFile, readAcceptedCatalog, refreshOfficialCatalog } from './catalog-release';
import { nativeManifestFromRelease, resolveNativeProduct } from './native-artifact';
import { describeReleaseError } from '../releases/channel-index';
import { releaseCacheFetch } from '../releases/cache';
import { loadCatalogEntries, type CatalogWarning } from './partial-catalog';
/**
 * Catalog fetcher — pulls app manifests from the Market sources.
 *
 * - The official Market is the `market` product of the box's channel index;
 *   every file comes from its accepted `catalog.tar` (see catalog-release.ts).
 *   Its native-app entries are id-only (`- id: notes`, `integration: native`):
 *   the app's manifest is the `youeye-app.yaml` asset of that product's
 *   release on the same channel.
 * - Custom sources added by URL are read as raw files from their branch.
 *   Their entries have `path`, `file` or `repo` (manifest in another repo).
 */

import { readFile, writeFile, mkdir, rename } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { parseBundle, parseCatalog, parseIntegrationManifest, parseManifest, parseStore, parseSystemManifest, parseUpdatePlan } from './parser';
import type { AppManifest, Catalog, CatalogEntry, IntegrationCatalogEntry, IntegrationManifest, MarketApp, MarketBundle, MarketCategory, MarketCuration, MigrationSpec, StoreDescriptor, SystemAppManifest, SystemCatalogEntry, UpdatePlanCatalogEntry } from './types';
import { catalogEntryRef, buildMarketRawURL, getMarketSource, getMarketSources, isChannelMarketSource, parseMarketRepoURL, recordMarketSourceResolution, type MarketSource } from './source';

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

export interface IntegrationManifestFetchResult {
  manifest: IntegrationManifest;
  reference: ManifestReference;
}

export interface UpdatePlanFetchResult {
  migrations: MigrationSpec[];
  references: ManifestReference[];
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

/** A raw file of a repository on a custom source's host. */
export async function fetchRepoFile(owner: string, repo: string, filePath: string, branch: string, source: MarketSource): Promise<string> {
  const url = buildMarketRawURL(source, owner, repo, filePath, branch);
  const res = await releaseCacheFetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Failed to fetch ${owner}/${repo}/${filePath}: ${res.status}`);
  return res.text();
}

// ─── Cache ────────────────────────────────────────────────

let catalogCache: Catalog | null = null;
let catalogCacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000;

const manifestCache = new Map<string, { manifest: AppManifest; reference?: ManifestReference; fetchedAt: number }>();

function digestManifest(yamlText: string): string {
  return `sha256:${createHash('sha256').update(yamlText).digest('hex')}`;
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
      return parseCatalog(accepted.files.get('catalog.yaml')!.toString('utf8'));
    } catch (error) {
      const message = describeReleaseError(error);
      source.refresh_error = message;
      await recordMarketSourceResolution(source.id, { error: message }).catch(() => {});
      const accepted = await readAcceptedCatalog().catch(() => null);
      if (accepted) return parseCatalog(accepted.files.get('catalog.yaml')!.toString('utf8'));
      throw error;
    }
  }
  try {
    const catalog = parseCatalog(await fetchFile('catalog.yaml', source));
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

/**
 * Fetch a manifest by app ID from the catalog.
 * Entry has `repo` (manifest in app's own repo) or `file` (manifest in Market).
 */
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

export async function fetchIntegrationManifestFromSource(integrationId: string, sourceId?: string): Promise<IntegrationManifest> {
  const source = sourceId
    ? (await getMarketSources()).find((s) => s.id === sourceId)
    : await getMarketSource();
  if (!source) throw new Error(`Market source "${sourceId}" not found`);

  const catalog = await fetchCatalog(source);
  const entry = (catalog.integrations ?? []).find((e) => e.id === integrationId);
  if (!entry) throw new Error(`Integration "${integrationId}" not found in Market source "${source.id}"`);

  const result = await fetchIntegrationManifestFromCatalogEntry(entry, source);
  return result.manifest;
}

export async function fetchIntegrationManifestReferenceFromSource(integrationId: string, sourceId?: string): Promise<ManifestReference> {
  const source = sourceId
    ? (await getMarketSources()).find((s) => s.id === sourceId)
    : await getMarketSource();
  if (!source) throw new Error(`Market source "${sourceId}" not found`);

  const catalog = await fetchCatalog(source);
  const entry = (catalog.integrations ?? []).find((e) => e.id === integrationId);
  if (!entry) throw new Error(`Integration "${integrationId}" not found in Market source "${source.id}"`);

  return (await fetchIntegrationManifestFromCatalogEntry(entry, source)).reference;
}

export async function fetchUpdatePlanMigrationsFromSource(appId: string, sourceId?: string): Promise<UpdatePlanFetchResult> {
  const source = sourceId
    ? (await getMarketSources()).find((s) => s.id === sourceId)
    : await getMarketSource();
  if (!source) throw new Error(`Market source "${sourceId}" not found`);

  const catalog = await fetchCatalog(source);
  const entries = (catalog.updatePlans ?? []).filter((entry) => entry.appId === appId);
  const migrations: MigrationSpec[] = [];
  const references: ManifestReference[] = [];

  for (const entry of entries) {
    const result = await fetchUpdatePlanFromCatalogEntry(entry, source);
    migrations.push(...result.migrations);
    references.push(result.reference);
  }

  return { migrations, references };
}

type FileLocation = { owner: string; repo: string; ref: string } | null;

/** Where a source's own files live: the official catalog.tar (null) or a custom repository at its branch. */
function sourceLocation(source: MarketSource): FileLocation {
  return isChannelMarketSource(source) ? null : { owner: source.organization, repo: source.repository, ref: sourceRef(source) };
}

function reference(source: MarketSource, location: FileLocation, filePath: string, yamlText: string): ManifestReference {
  return {
    path: filePath,
    repo: location ? `${location.owner}/${location.repo}` : 'official',
    branch: location?.ref ?? '',
    digest: digestManifest(yamlText),
  };
}

async function fetchManifestFromCatalogEntry(
  entry: CatalogEntry,
  source: MarketSource
): Promise<ManifestFetchResult> {
  // Id-only native entries name a product of the box's channel index.
  if (entry.integration === 'native' && !entry.repo && !entry.path && !entry.file) {
    const selected = await resolveNativeProduct(entry.id);
    const { manifest, contract } = await nativeManifestFromRelease(selected);
    return {
      manifest,
      reference: { path: 'youeye-app.yaml', repo: selected.repository, branch: selected.release.tag, digest: digestManifest(contract.toString('utf8')), build: selected.build.build_version },
    };
  }

  let location = sourceLocation(source);
  let manifest: AppManifest;
  let manifestPath: string;
  let yamlText: string;
  // For the per-app folder layout (`path:`), assets (icon.svg, screenshots/) are
  // resolved relative to the app folder rather than the repo root.
  let basePath: string | undefined;

  if (entry.repo) {
    if (!location) throw new Error(`Official catalog entry "${entry.id}" may not name a repository`);
    const [owner, repoName] = entry.repo.split('/');
    location = { owner, repo: repoName, ref: catalogEntryRef(entry, location.ref) };
    manifestPath = entry.manifest || 'youeye-app.yaml';
    yamlText = await fetchRepoFile(owner, repoName, manifestPath, location.ref, source);
    manifest = parseManifest(yamlText);
  } else if (entry.path) {
    basePath = entry.path.replace(/\/+$/, '');
    manifestPath = `${basePath}/${entry.manifest}`;
    yamlText = await fetchFile(manifestPath, source);
    manifest = parseManifest(yamlText);
    // Co-located icon convention: apps/<id>/icon.svg unless the manifest declares its own.
    if (!manifest.metadata.iconUrl) manifest.metadata.iconUrl = 'icon.svg';
  } else if (entry.file) {
    manifestPath = entry.file;
    yamlText = await fetchFile(manifestPath, source);
    manifest = parseManifest(yamlText);
  } else {
    throw new Error(`Catalog entry for "${entry.id}" has none of: path, file, repo`);
  }

  await resolveManifestPaths(manifest, source, location, basePath);
  return { manifest, reference: reference(source, location, manifestPath, yamlText) };
}

async function fetchIntegrationManifestFromCatalogEntry(
  entry: IntegrationCatalogEntry,
  source: MarketSource
): Promise<IntegrationManifestFetchResult> {
  let location = sourceLocation(source);
  let manifest: IntegrationManifest;
  let manifestPath: string;
  let yamlText: string;

  if (entry.repo) {
    if (!location) throw new Error(`Official catalog integration "${entry.id}" may not name a repository`);
    const [owner, repoName] = entry.repo.split('/');
    location = { owner, repo: repoName, ref: catalogEntryRef(entry, location.ref) };
    manifestPath = entry.manifest || 'youeye-integration.yaml';
    yamlText = await fetchRepoFile(owner, repoName, manifestPath, location.ref, source);
    manifest = parseIntegrationManifest(yamlText);
  } else if (entry.file) {
    manifestPath = entry.file;
    yamlText = await fetchFile(manifestPath, source);
    manifest = parseIntegrationManifest(yamlText);
  } else {
    throw new Error(`Integration catalog entry for "${entry.id}" has neither repo nor file`);
  }

  await resolveManifestPaths(manifest as unknown as AppManifest, source, location);
  return { manifest, reference: reference(source, location, manifestPath, yamlText) };
}

async function fetchUpdatePlanFromCatalogEntry(
  entry: UpdatePlanCatalogEntry,
  source: MarketSource
): Promise<{ migrations: MigrationSpec[]; reference: ManifestReference }> {
  const yamlText = await fetchFile(entry.file, source);
  const plan = parseUpdatePlan(yamlText);
  if (plan.appId !== entry.appId) {
    throw new Error(`Update plan "${entry.id}" appId mismatch: catalog=${entry.appId}, plan=${plan.appId}`);
  }
  return { migrations: plan.migrations, reference: reference(source, sourceLocation(source), entry.file, yamlText) };
}

async function fetchSystemManifestFromCatalogEntry(
  entry: SystemCatalogEntry,
  source: MarketSource
): Promise<SystemManifestFetchResult> {
  const yamlText = await fetchFile(entry.file, source);
  const manifest = parseSystemManifest(yamlText);
  if (manifest.metadata.id !== entry.id) {
    throw new Error(`System manifest "${entry.id}" id mismatch: catalog=${entry.id}, manifest=${manifest.metadata.id}`);
  }
  return { manifest, reference: reference(source, sourceLocation(source), entry.file, yamlText) };
}

/**
 * Fetch a manifest from a repo URL (for custom/non-catalog installs).
 * Expects youeye-app.yaml at the repo root (or specified filename).
 */
export async function fetchManifestFromRepo(
  repoUrl: string,
  manifestFile = 'youeye-app.yaml',
  branch = DEFAULT_BRANCH,
): Promise<AppManifest> {
  const source = parseMarketRepoURL(repoUrl.includes('://') ? repoUrl : `https://github.com/${repoUrl}`, { branch });
  const yamlText = await fetchRepoFile(source.organization, source.repository, manifestFile, source.branch, source);
  const manifest = parseManifest(yamlText);
  await resolveManifestPaths(manifest, source, sourceLocation(source));
  return manifest;
}

// ─── Image Proxy ──────────────────────────────────────────

export async function resolveManifestPaths(
  manifest: AppManifest,
  source: MarketSource,
  location: FileLocation,
  /** App folder for the per-app layout (e.g. `apps/redlib`); relative assets resolve under it. */
  basePath?: string
): Promise<void> {
  const relative = (asset: string) => basePath ? `${basePath.replace(/\/+$/, '')}/${asset}` : asset;
  const assetURL = (asset: string) => location
    ? proxyImageUrl(buildMarketRawURL(source, location.owner, location.repo, relative(asset), location.ref))
    : catalogImageUrl(relative(asset));
  const present = (value: string) => value.startsWith('http') ? proxyImageUrl(value) : assetURL(value);

  if (manifest.metadata.iconUrl) manifest.metadata.iconUrl = present(manifest.metadata.iconUrl);
  for (const screenshot of manifest.detail?.screenshots ?? []) {
    if (screenshot.path) screenshot.path = present(screenshot.path);
  }
}

// ─── MarketApp Conversion ─────────────────────────────────

function getDisplayIntegrations(manifest: AppManifest): NonNullable<MarketApp['integrations']> {
  const integrations: NonNullable<MarketApp['integrations']> = (manifest.integrations ?? []).map((integration) => ({
    id: integration.id,
    name: integration.name,
    description: integration.description,
    type: integration.type,
    recommended: integration.recommended,
    installByDefault: integration.installByDefault,
    required: integration.required,
    permissions: integration.permissions,
  }));

  const setupMethod = manifest.sso?.setup?.method;
  const hasSetupSteps =
    (setupMethod === 'api' && (manifest.sso?.setup?.api?.steps?.length ?? 0) > 0) ||
    (setupMethod === 'cli' && (manifest.sso?.setup?.cli?.steps?.length ?? 0) > 0);

  if (hasSetupSteps && !integrations.some((integration) => integration.id === 'youeye-id')) {
    integrations.unshift({
      id: 'youeye-id',
      name: 'Identity Sign-In',
      description: 'Configure this app to use the identity provider after the base app is installed.',
      type: 'identity',
      recommended: true,
      installByDefault: true,
      required: false,
      permissions: ['identity:oauth-client:create'],
    });
  }

  return integrations;
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
    installParams: manifest.installParams?.map((p) => ({
      name: p.name,
      label: p.label,
      required: p.required,
      description: p.description,
      type: p.type,
      default: p.default,
      choices: p.choices,
      validation: p.validation,
    })),
    integrations: getDisplayIntegrations(manifest),
    entrances: manifest.entrances,
    forwardAuth: manifest.forwardAuth,
    capabilities,
    surfaces: manifest.surfaces,
  };
}

function integrationManifestToMarketApp(manifest: IntegrationManifest, source?: MarketSource, reference?: ManifestReference): MarketApp {
  return {
    id: manifest.metadata.id,
    catalogKey: source ? `${source.id}:integration:${manifest.metadata.id}` : undefined,
    itemKind: 'integration',
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
    integration: 'basic',
    version: manifest.version,
    defaultSubdomain: '',
    supportsSSO: !!manifest.sso,
    website: manifest.metadata.website,
    tags: manifest.metadata.tags,
    detail: manifest.detail ? {
      longDescription: manifest.detail.longDescription,
      screenshots: manifest.detail.screenshots.map((s) => ({
        url: s.path,
        caption: s.caption,
      })),
    } : undefined,
    target: manifest.target,
    integrations: [{
      id: manifest.metadata.id,
      name: manifest.metadata.name,
      description: manifest.metadata.description,
      type: manifest.type,
      recommended: manifest.recommended,
      installByDefault: manifest.installByDefault,
      required: manifest.required,
      permissions: manifest.permissions,
      hasUninstall: !!manifest.uninstall,
    }],
  };
}

function systemManifestToMarketApp(manifest: SystemAppManifest, source?: MarketSource, reference?: ManifestReference): MarketApp {
  return {
    id: manifest.metadata.id,
    catalogKey: source ? `${source.id}:system:${manifest.metadata.id}` : undefined,
    itemKind: 'system',
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
    integration: 'basic',
    version: manifest.version,
    defaultSubdomain: '',
    supportsSSO: false,
    website: manifest.metadata.website,
    tags: manifest.metadata.tags,
    system: {
      image: manifest.image,
      containerName: manifest.containerName,
      minPlatformVersion: manifest.minPlatformVersion,
      managedBy: 'control-panel',
    },
  };
}

function integrationItemToAppToggle(item: MarketApp): NonNullable<MarketApp['integrations']>[number] {
  const integration = item.integrations?.[0];
  return {
    id: item.id,
    name: item.name,
    description: item.description,
    type: integration?.type ?? 'addon',
    recommended: integration?.recommended,
    installByDefault: integration?.installByDefault,
    required: integration?.required,
    permissions: integration?.permissions,
    itemKind: 'integration',
    sourceId: item.sourceId,
    sourceName: item.sourceName,
    sourceRepoUrl: item.sourceRepoUrl,
    manifestPath: item.manifestPath,
    manifestRepo: item.manifestRepo,
    manifestBranch: item.manifestBranch,
    manifestDigest: item.manifestDigest,
  };
}

function attachStandaloneIntegrations(items: MarketApp[]): MarketApp[] {
  const integrationsByTarget = new Map<string, MarketApp[]>();
  for (const item of items) {
    if (item.itemKind !== 'integration' || !item.target?.appId) continue;
    const key = `${item.sourceId || ''}:${item.target.appId}`;
    integrationsByTarget.set(key, [...(integrationsByTarget.get(key) ?? []), item]);
  }

  return items.map((item) => {
    if (item.itemKind === 'integration') return item;

    const key = `${item.sourceId || ''}:${item.id}`;
    const standalone = integrationsByTarget.get(key) ?? [];
    if (standalone.length === 0) return item;

    const standaloneToggles = standalone.map(integrationItemToAppToggle);
    const standaloneIds = new Set(standaloneToggles.map((integration) => integration.id));
    const hasStandaloneIdentity = standaloneToggles.some((integration) => integration.type === 'identity');
    const embedded = (item.integrations ?? []).filter((integration) => (
      !standaloneIds.has(integration.id) &&
      !(hasStandaloneIdentity && integration.id === 'youeye-id')
    ));

    return {
      ...item,
      integrations: [...standaloneToggles, ...embedded],
    };
  });
}

// ─── Public API ───────────────────────────────────────────

export async function fetchAvailableApps(onWarning?: (warning: CatalogWarning) => void): Promise<MarketApp[]> {
  const sources = await getMarketSources();
  const apps: MarketApp[] = [];

  const results = await Promise.allSettled(sources.flatMap(async (source) => {
    const catalog = await fetchCatalog(source);
    const reportFailure = (entry: { id: string }, error: unknown) => {
      console.warn(`[market] ${source.id}/${entry.id}: manifest unavailable`, error);
      onWarning?.({ sourceId: source.id, itemId: entry.id, message: `${source.name}: could not load ${entry.id}.` });
    };
    const appItems = await loadCatalogEntries(catalog.apps, async (entry) => {
      const result = await fetchManifestFromCatalogEntry(entry, source);
      return manifestToMarketApp(result.manifest, source, result.reference);
    }, reportFailure);
    const integrationItems = await loadCatalogEntries(catalog.integrations ?? [], async (entry) => {
      const result = await fetchIntegrationManifestFromCatalogEntry(entry, source);
      return integrationManifestToMarketApp(result.manifest, source, result.reference);
    }, reportFailure);
    return [...appItems, ...integrationItems];
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

  return attachStandaloneIntegrations(apps);
}

/**
 * Fetch Market category metadata (pills, labels, icons, ordering, fallback tiles) from the
 * enabled sources. Categories are merged by id across sources in priority order — the first
 * source to declare a category id wins — and returned sorted by `order`. Data-driven:
 * adding/renaming a category is a `catalog.yaml` change only, no code change.
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
 * Fetch the Market curation (spotlight strip + collections) for the Market home. Curation
 * is an editorial layout owned by the primary market, so the first enabled source (priority
 * order) that declares a `curation:` section wins. Returns null if none is declared.
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
 * Fetch the full bundle definitions across enabled Market sources. Reads each source's
 * catalog `bundles:` entries ({id, file}) and loads + validates the referenced
 * `bundles/<id>/bundle.yaml`. Deduped by bundle id in source-priority order. A bundle that
 * fails to load is logged and skipped (it never breaks the rest of the catalog response).
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
    for (const entry of catalog.bundles ?? []) {
      if (seen.has(entry.id)) continue;
      try {
        const yamlText = await fetchFile(entry.file, source);
        out.push(parseBundle(yamlText));
        seen.add(entry.id);
      } catch (err) {
        console.error(`[catalog] Failed to load bundle "${entry.id}" (${entry.file}):`, err);
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

/**
 * Fetch a source's `store.yaml` descriptor (new market layout), or null if the source has
 * none (legacy layout). Official stores keep un-namespaced app ids; third-party stores
 * namespace by their descriptor `id`. Best-effort: a missing/invalid store.yaml is not an error.
 */
export async function fetchStoreDescriptor(marketSource?: MarketSource): Promise<StoreDescriptor | null> {
  try {
    const yamlText = await fetchFile('store.yaml', marketSource);
    return parseStore(yamlText);
  } catch {
    return null;
  }
}

export async function fetchAvailableSystemApps(): Promise<MarketApp[]> {
  const sources = await getMarketSources();
  const systemApps: MarketApp[] = [];

  const results = await Promise.allSettled(sources.flatMap(async (source) => {
    const catalog = await fetchCatalog(source);
    return Promise.all((catalog.system ?? []).map(async (entry) => {
      const result = await fetchSystemManifestFromCatalogEntry(entry, source);
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

export async function getNativeApps(): Promise<MarketApp[]> {
  let catalog: Catalog;
  try {
    catalog = await fetchCatalog();
  } catch {
    const cached = await loadCatalogFromFile();
    if (!cached) return [];
    catalog = cached.catalog;
  }

  const nativeEntries = catalog.apps.filter(e => e.integration === 'native');
  const nativeApps: MarketApp[] = [];

  for (const entry of nativeEntries) {
    try {
      const manifest = await fetchManifest(entry.id);
      nativeApps.push(manifestToMarketApp(manifest));
    } catch {}
  }

  return nativeApps;
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
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
