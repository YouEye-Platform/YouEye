/**
 * Catalog fetcher — pulls app manifests from AppMarket, app repos, or URLs.
 *
 * Catalog format: flat `apps[]` list. Each entry has `repo` (manifest in
 * app's own repo) or `file` (manifest in AppMarket). Also supports install
 * from arbitrary repo URL (any repo with youeye-app.yaml).
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { parseCatalog, parseIntegrationManifest, parseManifest, parseSystemManifest, parseUpdatePlan } from './parser';
import type { AppManifest, Catalog, CatalogEntry, IntegrationCatalogEntry, IntegrationManifest, MarketApp, MarketCategory, MarketCuration, MigrationSpec, SystemAppManifest, SystemCatalogEntry, UpdatePlanCatalogEntry } from './types';
import { settingsService } from '@/lib/settings';
import { buildMarketRawURL, getMarketSource, getMarketSources, isGitHubMarketSource, type MarketSource } from './source';

const CATALOG_CACHE_DIR = '/var/lib/youeye';
const CATALOG_CACHE_PATH = path.join(CATALOG_CACHE_DIR, 'catalog-cache.json');

const DEFAULT_BRANCH = 'main';

export interface ManifestReference {
  path: string;
  repo: string;
  branch: string;
  digest: string;
}

export interface ManifestFetchResult {
  manifest: AppManifest;
  reference: ManifestReference;
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

// ─── Branch Resolution ────────────────────────────────────

export async function getEffectiveBranch(): Promise<string> {
  try {
    const config = await settingsService.getRaw();
    return config.release_branch || DEFAULT_BRANCH;
  } catch {
    return DEFAULT_BRANCH;
  }
}

// ─── File Fetching ────────────────────────────────────────

export async function fetchFile(filePath: string, branch?: string, marketSource?: MarketSource): Promise<string> {
  const source = marketSource || await getMarketSource();
  const owner = source.organization;
  const repo = source.repository;
  const effectiveBranch = branch || DEFAULT_BRANCH;
  const url = buildMarketRawURL(source, owner, repo, filePath, effectiveBranch);
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });

  if (!res.ok && effectiveBranch !== DEFAULT_BRANCH) {
    const fallbackUrl = buildMarketRawURL(source, owner, repo, filePath, DEFAULT_BRANCH);
    const fallbackRes = await fetch(fallbackUrl, { signal: AbortSignal.timeout(15_000) });
    if (!fallbackRes.ok) throw new Error(`Failed to fetch ${filePath}: ${fallbackRes.status}`);
    return fallbackRes.text();
  }

  if (!res.ok) throw new Error(`Failed to fetch ${filePath}: ${res.status}`);
  return res.text();
}

export async function fetchRepoFile(owner: string, repo: string, filePath: string, branch: string, marketSource?: MarketSource): Promise<string> {
  const source = marketSource || await getMarketSource();
  const url = buildMarketRawURL(source, owner, repo, filePath, branch);
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });

  if (!res.ok && branch !== DEFAULT_BRANCH) {
    const fallbackUrl = buildMarketRawURL(source, owner, repo, filePath, DEFAULT_BRANCH);
    const fallbackRes = await fetch(fallbackUrl, { signal: AbortSignal.timeout(15_000) });
    if (!fallbackRes.ok) throw new Error(`Failed to fetch ${owner}/${repo}/${filePath}: ${fallbackRes.status}`);
    return fallbackRes.text();
  }

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
    const branch = await getEffectiveBranch();
    const yamlText = await fetchFile('catalog.yaml', branch, marketSource);
    return parseCatalog(yamlText);
  }

  if (catalogCache && Date.now() - catalogCacheTime < CACHE_TTL) {
    return catalogCache;
  }

  try {
    const branch = await getEffectiveBranch();
    const yamlText = await fetchFile('catalog.yaml', branch);
    catalogCache = parseCatalog(yamlText);
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

// ─── Manifest Fetching ────────────────────────────────────

/**
 * Fetch a manifest by app ID from the catalog.
 * Entry has `repo` (manifest in app's own repo) or `file` (manifest in AppMarket).
 */
export async function fetchManifest(appId: string): Promise<AppManifest> {
  const cached = manifestCache.get(appId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
    return cached.manifest;
  }

  const catalog = await fetchCatalog();
  const branch = await getEffectiveBranch();
  const entry = catalog.apps.find(e => e.id === appId);

  if (!entry) throw new Error(`App "${appId}" not found in catalog`);

  const source = await getMarketSource();
  const result = await fetchManifestFromCatalogEntry(entry, branch, source);

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
  const branch = await getEffectiveBranch();
  const entry = catalog.apps.find((e) => e.id === appId);
  if (!entry) throw new Error(`App "${appId}" not found in Market source "${sourceId}"`);

  const result = await fetchManifestFromCatalogEntry(entry, branch, source);
  manifestCache.set(cacheKey, { manifest: result.manifest, reference: result.reference, fetchedAt: Date.now() });
  return result.manifest;
}

export async function fetchManifestReferenceFromSource(appId: string, sourceId?: string): Promise<ManifestReference> {
  const source = sourceId
    ? (await getMarketSources()).find((s) => s.id === sourceId)
    : await getMarketSource();
  if (!source) throw new Error(`Market source "${sourceId}" not found`);

  const catalog = await fetchCatalog(source);
  const branch = await getEffectiveBranch();
  const entry = catalog.apps.find((e) => e.id === appId);
  if (!entry) throw new Error(`App "${appId}" not found in Market source "${source.id}"`);

  return (await fetchManifestFromCatalogEntry(entry, branch, source)).reference;
}

export async function fetchIntegrationManifestFromSource(integrationId: string, sourceId?: string): Promise<IntegrationManifest> {
  const source = sourceId
    ? (await getMarketSources()).find((s) => s.id === sourceId)
    : await getMarketSource();
  if (!source) throw new Error(`Market source "${sourceId}" not found`);

  const catalog = await fetchCatalog(source);
  const branch = await getEffectiveBranch();
  const entry = (catalog.integrations ?? []).find((e) => e.id === integrationId);
  if (!entry) throw new Error(`Integration "${integrationId}" not found in Market source "${source.id}"`);

  const result = await fetchIntegrationManifestFromCatalogEntry(entry, branch, source);
  return result.manifest;
}

export async function fetchIntegrationManifestReferenceFromSource(integrationId: string, sourceId?: string): Promise<ManifestReference> {
  const source = sourceId
    ? (await getMarketSources()).find((s) => s.id === sourceId)
    : await getMarketSource();
  if (!source) throw new Error(`Market source "${sourceId}" not found`);

  const catalog = await fetchCatalog(source);
  const branch = await getEffectiveBranch();
  const entry = (catalog.integrations ?? []).find((e) => e.id === integrationId);
  if (!entry) throw new Error(`Integration "${integrationId}" not found in Market source "${source.id}"`);

  return (await fetchIntegrationManifestFromCatalogEntry(entry, branch, source)).reference;
}

export async function fetchUpdatePlanMigrationsFromSource(appId: string, sourceId?: string): Promise<UpdatePlanFetchResult> {
  const source = sourceId
    ? (await getMarketSources()).find((s) => s.id === sourceId)
    : await getMarketSource();
  if (!source) throw new Error(`Market source "${sourceId}" not found`);

  const catalog = await fetchCatalog(source);
  const branch = await getEffectiveBranch();
  const entries = (catalog.updatePlans ?? []).filter((entry) => entry.appId === appId);
  const migrations: MigrationSpec[] = [];
  const references: ManifestReference[] = [];

  for (const entry of entries) {
    const result = await fetchUpdatePlanFromCatalogEntry(entry, branch, source);
    migrations.push(...result.migrations);
    references.push(result.reference);
  }

  return { migrations, references };
}

async function fetchManifestFromCatalogEntry(
  entry: CatalogEntry,
  branch: string,
  source: MarketSource
): Promise<ManifestFetchResult> {
  let manifest: AppManifest;
  let resolveOwner = source.organization;
  let resolveRepo = source.repository;
  let manifestPath: string;
  let yamlText: string;

  if (entry.repo) {
    const [owner, repoName] = entry.repo.split('/');
    resolveOwner = owner;
    resolveRepo = repoName;
    manifestPath = entry.manifest || 'youeye-app.yaml';
    yamlText = await fetchRepoFile(owner, repoName, manifestPath, branch, source);
    manifest = parseManifest(yamlText);
  } else if (entry.file) {
    manifestPath = entry.file;
    yamlText = await fetchFile(manifestPath, branch, source);
    manifest = parseManifest(yamlText);
  } else {
    throw new Error(`Catalog entry for "${entry.id}" has neither repo nor file`);
  }

  await resolveManifestPaths(manifest, resolveOwner, resolveRepo, branch, source);
  return {
    manifest,
    reference: {
      path: manifestPath,
      repo: `${resolveOwner}/${resolveRepo}`,
      branch,
      digest: digestManifest(yamlText),
    },
  };
}

async function fetchIntegrationManifestFromCatalogEntry(
  entry: IntegrationCatalogEntry,
  branch: string,
  source: MarketSource
): Promise<IntegrationManifestFetchResult> {
  let manifest: IntegrationManifest;
  let resolveOwner = source.organization;
  let resolveRepo = source.repository;
  let manifestPath: string;
  let yamlText: string;

  if (entry.repo) {
    const [owner, repoName] = entry.repo.split('/');
    resolveOwner = owner;
    resolveRepo = repoName;
    manifestPath = entry.manifest || 'youeye-integration.yaml';
    yamlText = await fetchRepoFile(owner, repoName, manifestPath, branch, source);
    manifest = parseIntegrationManifest(yamlText);
  } else if (entry.file) {
    manifestPath = entry.file;
    yamlText = await fetchFile(manifestPath, branch, source);
    manifest = parseIntegrationManifest(yamlText);
  } else {
    throw new Error(`Integration catalog entry for "${entry.id}" has neither repo nor file`);
  }

  await resolveManifestPaths(manifest as unknown as AppManifest, resolveOwner, resolveRepo, branch, source);
  return {
    manifest,
    reference: {
      path: manifestPath,
      repo: `${resolveOwner}/${resolveRepo}`,
      branch,
      digest: digestManifest(yamlText),
    },
  };
}

async function fetchUpdatePlanFromCatalogEntry(
  entry: UpdatePlanCatalogEntry,
  branch: string,
  source: MarketSource
): Promise<{ migrations: MigrationSpec[]; reference: ManifestReference }> {
  const yamlText = await fetchFile(entry.file, branch, source);
  const plan = parseUpdatePlan(yamlText);
  if (plan.appId !== entry.appId) {
    throw new Error(`Update plan "${entry.id}" appId mismatch: catalog=${entry.appId}, plan=${plan.appId}`);
  }

  return {
    migrations: plan.migrations,
    reference: {
      path: entry.file,
      repo: `${source.organization}/${source.repository}`,
      branch,
      digest: digestManifest(yamlText),
    },
  };
}

async function fetchSystemManifestFromCatalogEntry(
  entry: SystemCatalogEntry,
  branch: string,
  source: MarketSource
): Promise<SystemManifestFetchResult> {
  const yamlText = await fetchFile(entry.file, branch, source);
  const manifest = parseSystemManifest(yamlText);
  if (manifest.metadata.id !== entry.id) {
    throw new Error(`System manifest "${entry.id}" id mismatch: catalog=${entry.id}, manifest=${manifest.metadata.id}`);
  }

  return {
    manifest,
    reference: {
      path: entry.file,
      repo: `${source.organization}/${source.repository}`,
      branch,
      digest: digestManifest(yamlText),
    },
  };
}

/**
 * Fetch a manifest from a repo URL (for custom/non-catalog installs).
 * Expects youeye-app.yaml at the repo root (or specified filename).
 */
export async function fetchManifestFromRepo(
  repoUrl: string,
  manifestFile = 'youeye-app.yaml',
  branch?: string,
): Promise<AppManifest> {
  // Parse repo URL — accept "owner/repo" or full URL
  let owner: string;
  let repo: string;

  if (repoUrl.includes('/') && !repoUrl.includes('://')) {
    // Format: "YouEye-Platform/Wiki"
    [owner, repo] = repoUrl.split('/');
  } else {
    // Full URL: extract owner/repo
    const parsed = new URL(repoUrl);
    const parts = parsed.pathname.replace(/^\/+|\/+$/g, '').split('/');
    if (parts.length < 2 || !parts[0] || !parts[1]) throw new Error(`Cannot parse repo URL: ${repoUrl}`);
    owner = parts[0];
    repo = parts[1].replace(/\.git$/, '');
  }

  const effectiveBranch = branch || await getEffectiveBranch();
  const yamlText = await fetchRepoFile(owner, repo, manifestFile, effectiveBranch);
  const manifest = parseManifest(yamlText);
  await resolveManifestPaths(manifest, owner, repo, effectiveBranch);
  return manifest;
}

// ─── Image Proxy ──────────────────────────────────────────

function proxyImageUrl(url: string): string {
  if (!url) return url;
  return `/api/market/image?url=${encodeURIComponent(url)}`;
}

async function resolveManifestPaths(
  manifest: AppManifest,
  owner: string,
  repo: string,
  branch: string,
  marketSource?: MarketSource
): Promise<void> {
  const source = marketSource || await getMarketSource();
  const baseUrl = isGitHubMarketSource(source)
    ? `https://raw.githubusercontent.com/${owner}/${repo}/${branch}`
    : `${source.base_url}${source.api_path}/repos/${owner}/${repo}/raw`;

  if (manifest.metadata.iconUrl && !manifest.metadata.iconUrl.startsWith('http')) {
    manifest.metadata.iconUrl = isGitHubMarketSource(source)
      ? `${baseUrl}/${manifest.metadata.iconUrl}`
      : `${baseUrl}/${manifest.metadata.iconUrl}?ref=${encodeURIComponent(branch)}`;
  }
  if (manifest.metadata.iconUrl) {
    manifest.metadata.iconUrl = proxyImageUrl(manifest.metadata.iconUrl);
  }

  if (manifest.detail?.screenshots) {
    for (const screenshot of manifest.detail.screenshots) {
      if (screenshot.path && !screenshot.path.startsWith('http')) {
        screenshot.path = isGitHubMarketSource(source)
          ? `${baseUrl}/${screenshot.path}`
          : `${baseUrl}/${screenshot.path}?ref=${encodeURIComponent(branch)}`;
      }
      if (screenshot.path) {
        screenshot.path = proxyImageUrl(screenshot.path);
      }
    }
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

function manifestToMarketApp(manifest: AppManifest, source?: MarketSource, reference?: ManifestReference): MarketApp {
  const hasNotificationSurface = manifest.surfaces.some(
    (surface) => surface.kind === 'notification' && surface.placement === 'notification-center'
  );
  const capabilities = manifest.capabilities || hasNotificationSurface ? {
    widgets: manifest.capabilities?.widgets,
    notifications: manifest.capabilities?.notifications || (hasNotificationSurface ? true : undefined),
    smtp: manifest.capabilities?.smtp,
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
    tags: manifest.metadata.tags,
    detail: manifest.detail ? {
      longDescription: manifest.detail.longDescription,
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

export async function fetchAvailableApps(): Promise<MarketApp[]> {
  const sources = await getMarketSources();
  const apps: MarketApp[] = [];

  const results = await Promise.allSettled(sources.flatMap(async (source) => {
    const catalog = await fetchCatalog(source);
    const branch = await getEffectiveBranch();
    const appItems = await Promise.all(catalog.apps.map(async (entry) => {
      const result = await fetchManifestFromCatalogEntry(entry, branch, source);
      return manifestToMarketApp(result.manifest, source, result.reference);
    }));
    const integrationItems = await Promise.all((catalog.integrations ?? []).map(async (entry) => {
      const result = await fetchIntegrationManifestFromCatalogEntry(entry, branch, source);
      return integrationManifestToMarketApp(result.manifest, source, result.reference);
    }));
    return [...appItems, ...integrationItems];
  }));

  for (const result of results) {
    if (result.status === 'fulfilled') {
      apps.push(...result.value);
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

export async function fetchAvailableSystemApps(): Promise<MarketApp[]> {
  const sources = await getMarketSources();
  const systemApps: MarketApp[] = [];

  const results = await Promise.allSettled(sources.flatMap(async (source) => {
    const catalog = await fetchCatalog(source);
    const branch = await getEffectiveBranch();
    return Promise.all((catalog.system ?? []).map(async (entry) => {
      const result = await fetchSystemManifestFromCatalogEntry(entry, branch, source);
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
    await writeFile(CATALOG_CACHE_PATH, JSON.stringify({ catalog, savedAt: new Date().toISOString() }, null, 2));
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
