/**
 * Catalog fetcher — pulls app manifests from the YE-AppMarket Gitea repo.
 * Fetches catalog.yaml to discover available apps, then individual manifests on demand.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { parseCatalog, parseManifest, parseAppRef } from './parser';
import type { AppManifest, Catalog, MarketApp } from './types';
import { settingsService } from '@/lib/settings';

const CATALOG_CACHE_DIR = '/var/lib/youeye';
const CATALOG_CACHE_PATH = path.join(CATALOG_CACHE_DIR, 'catalog-cache.json');

const GITEA_BASE = 'https://git.byka.wtf';
const REPO_OWNER = 'potemsla';
const REPO_NAME = 'YE-AppMarket';
const DEFAULT_BRANCH = 'main';

/**
 * Get the configured release branch from Spine config.
 * Falls back to 'main' if not set or on error.
 */
export async function getEffectiveBranch(): Promise<string> {
  try {
    const config = await settingsService.getRaw();
    return config.release_branch || DEFAULT_BRANCH;
  } catch {
    return DEFAULT_BRANCH;
  }
}

/**
 * Build a raw file URL for a file in the AppMarket repo.
 * Uses the configured release branch (git branch, not tag prefix).
 */
function rawUrl(filePath: string, branch: string): string {
  return `${GITEA_BASE}/${REPO_OWNER}/${REPO_NAME}/raw/branch/${branch}/${filePath}`;
}

/**
 * Fetch a text file from the AppMarket repo.
 * Tries the configured branch first, falls back to main if that branch doesn't exist.
 */
export async function fetchFile(filePath: string, branch?: string): Promise<string> {
  const effectiveBranch = branch || DEFAULT_BRANCH;
  const url = rawUrl(filePath, effectiveBranch);
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });

  if (!res.ok && effectiveBranch !== DEFAULT_BRANCH) {
    // Fallback to main branch if the configured branch doesn't exist
    const fallbackUrl = rawUrl(filePath, DEFAULT_BRANCH);
    const fallbackRes = await fetch(fallbackUrl, { signal: AbortSignal.timeout(15_000) });
    if (!fallbackRes.ok) {
      throw new Error(`Failed to fetch ${filePath}: ${fallbackRes.status} ${fallbackRes.statusText}`);
    }
    return fallbackRes.text();
  }

  if (!res.ok) {
    throw new Error(`Failed to fetch ${filePath}: ${res.status} ${res.statusText}`);
  }
  return res.text();
}

/**
 * Fetch a text file from any Gitea repo (not just AppMarket).
 * Used for fetching manifests from native app repos.
 */
export async function fetchRepoFile(owner: string, repo: string, filePath: string, branch: string): Promise<string> {
  const url = `${GITEA_BASE}/${owner}/${repo}/raw/branch/${branch}/${filePath}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });

  if (!res.ok && branch !== DEFAULT_BRANCH) {
    // Fallback to main branch
    const fallbackUrl = `${GITEA_BASE}/${owner}/${repo}/raw/branch/${DEFAULT_BRANCH}/${filePath}`;
    const fallbackRes = await fetch(fallbackUrl, { signal: AbortSignal.timeout(15_000) });
    if (!fallbackRes.ok) {
      throw new Error(`Failed to fetch ${owner}/${repo}/${filePath}: ${fallbackRes.status}`);
    }
    return fallbackRes.text();
  }

  if (!res.ok) {
    throw new Error(`Failed to fetch ${owner}/${repo}/${filePath}: ${res.status}`);
  }
  return res.text();
}

// ─── In-memory cache ───────────────────────────────────────

let catalogCache: Catalog | null = null;
let catalogCacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

const manifestCache = new Map<string, { manifest: AppManifest; fetchedAt: number }>();

/**
 * Fetch the app catalog. Cached for 5 minutes in memory.
 * On successful fetch, also saves to disk for resilience.
 * On failure, falls back to the disk cache.
 */
export async function fetchCatalog(): Promise<Catalog> {
  if (catalogCache && Date.now() - catalogCacheTime < CACHE_TTL) {
    return catalogCache;
  }

  try {
    const branch = await getEffectiveBranch();
    const yamlText = await fetchFile('catalog.yaml', branch);
    catalogCache = parseCatalog(yamlText);
    catalogCacheTime = Date.now();

    // Persist to disk for offline resilience
    saveCatalogToFile(catalogCache).catch(() => {
      /* best effort */
    });

    return catalogCache;
  } catch (err) {
    // Try loading from disk cache
    const cached = await loadCatalogFromFile();
    if (cached) {
      catalogCache = cached.catalog;
      catalogCacheTime = Date.now();
      return catalogCache;
    }
    throw err;
  }
}

/**
 * Fetch a single app manifest by ID.
 * For native apps: fetches the app-ref pointer from AppMarket, then the actual manifest from the native app's repo.
 * For external apps: fetches the manifest directly from AppMarket.
 */
export async function fetchManifest(appId: string): Promise<AppManifest> {
  // Check cache
  const cached = manifestCache.get(appId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
    return cached.manifest;
  }

  const catalog = await fetchCatalog();
  const branch = await getEffectiveBranch();

  // Check native entries first
  const nativeEntry = catalog.native.find((e) => e.id === appId);
  if (nativeEntry) {
    // Fetch the app-ref pointer from AppMarket
    const refYaml = await fetchFile(nativeEntry.file, branch);
    const ref = parseAppRef(refYaml);

    // Fetch the actual manifest from the native app's repo
    const [owner, repoName] = ref.repo.split('/');
    const manifestYaml = await fetchRepoFile(owner, repoName, ref.manifest, branch);
    const manifest = parseManifest(manifestYaml);

    // Resolve relative paths against the native app's repo
    resolveManifestPaths(manifest, owner, repoName, branch);

    manifestCache.set(appId, { manifest, fetchedAt: Date.now() });
    return manifest;
  }

  // Check external entries
  const externalEntry = catalog.external.find((e) => e.id === appId);
  if (externalEntry) {
    const yamlText = await fetchFile(externalEntry.file, branch);
    const manifest = parseManifest(yamlText);

    // Verify manifest ID matches catalog entry
    if (manifest.metadata.id !== appId) {
      throw new Error(`Manifest ID "${manifest.metadata.id}" doesn't match catalog entry "${appId}"`);
    }

    // Resolve relative paths against AppMarket repo
    resolveManifestPaths(manifest, REPO_OWNER, REPO_NAME, branch);

    manifestCache.set(appId, { manifest, fetchedAt: Date.now() });
    return manifest;
  }

  throw new Error(`App "${appId}" not found in catalog`);
}

/**
 * Wrap an external image URL with the CP image proxy.
 * The proxy fetches the image server-side, bypassing CORS/TLS issues
 * (e.g. self-signed certs on git.byka.wtf).
 */
function proxyImageUrl(url: string): string {
  if (!url) return url;
  return `/api/market/image?url=${encodeURIComponent(url)}`;
}

/**
 * Resolve relative paths in a manifest to absolute Gitea raw URLs,
 * then wrap them with the image proxy so the browser can load them.
 */
function resolveManifestPaths(manifest: AppManifest, owner: string, repo: string, branch: string): void {
  const baseUrl = `${GITEA_BASE}/${owner}/${repo}/raw/branch/${branch}`;

  // Resolve iconUrl if it's a relative path
  if (manifest.metadata.iconUrl && !manifest.metadata.iconUrl.startsWith('http')) {
    manifest.metadata.iconUrl = `${baseUrl}/${manifest.metadata.iconUrl}`;
  }
  // Proxy the icon URL so the browser doesn't hit self-signed certs
  if (manifest.metadata.iconUrl) {
    manifest.metadata.iconUrl = proxyImageUrl(manifest.metadata.iconUrl);
  }

  // Resolve screenshot paths
  if (manifest.detail?.screenshots) {
    for (const screenshot of manifest.detail.screenshots) {
      if (screenshot.path && !screenshot.path.startsWith('http')) {
        screenshot.path = `${baseUrl}/${screenshot.path}`;
      }
      // Proxy the screenshot URL
      if (screenshot.path) {
        screenshot.path = proxyImageUrl(screenshot.path);
      }
    }
  }
}

/**
 * Get all available apps as simplified MarketApp objects for UI display.
 * Iterates over both native and external catalog entries (skips system for now).
 */
export async function fetchAvailableApps(): Promise<MarketApp[]> {
  const catalog = await fetchCatalog();
  const apps: MarketApp[] = [];

  // Collect all entry IDs from native + external
  const allEntries = [
    ...catalog.native.map((e) => e.id),
    ...catalog.external.map((e) => e.id),
  ];

  // Fetch all manifests in parallel
  const results = await Promise.allSettled(
    allEntries.map(async (id) => {
      const manifest = await fetchManifest(id);
      return manifestToMarketApp(manifest);
    })
  );

  for (const result of results) {
    if (result.status === 'fulfilled') {
      apps.push(result.value);
    }
  }

  return apps;
}

/**
 * Convert an AppManifest to a MarketApp for UI display.
 */
function manifestToMarketApp(manifest: AppManifest): MarketApp {
  return {
    id: manifest.metadata.id,
    name: manifest.metadata.name,
    description: manifest.metadata.description,
    icon: manifest.metadata.icon,
    iconUrl: manifest.metadata.iconUrl,
    category: manifest.metadata.category,
    type: manifest.type ?? 'marketplace',
    version: manifest.version,
    defaultSubdomain: manifest.metadata.defaultSubdomain,
    supportsSSO: manifest.features.supportsSSO,
    website: manifest.metadata.website,
    tags: manifest.metadata.tags,
    detail: manifest.detail ? {
      longDescription: manifest.detail.longDescription,
      screenshots: manifest.detail.screenshots.map((s) => ({
        url: s.path, // already resolved to absolute URL
        caption: s.caption,
      })),
    } : undefined,
    installParams: manifest.native?.installParams?.map((p) => ({
      name: p.name,
      label: p.label,
      required: p.required,
      description: p.description,
    })),
  };
}

/**
 * Clear the catalog and manifest caches. Used after catalog updates.
 */
export function clearCatalogCache(): void {
  catalogCache = null;
  catalogCacheTime = 0;
  manifestCache.clear();
}

// ─── Catalog Cache Persistence ──────────────────────────────

interface CatalogCacheFile {
  catalog: Catalog;
  savedAt: string;
}

/**
 * Save the catalog to a local cache file for resilience.
 * If Gitea is unreachable on next fetch, the cached version is used.
 */
async function saveCatalogToFile(catalog: Catalog): Promise<void> {
  try {
    if (!existsSync(CATALOG_CACHE_DIR)) {
      await mkdir(CATALOG_CACHE_DIR, { recursive: true });
    }
    const cacheData: CatalogCacheFile = {
      catalog,
      savedAt: new Date().toISOString(),
    };
    await writeFile(CATALOG_CACHE_PATH, JSON.stringify(cacheData, null, 2));
  } catch {
    // Best effort — failing to cache is not fatal
  }
}

/**
 * Load catalog from the local cache file.
 * Returns null if cache doesn't exist or is corrupted.
 */
async function loadCatalogFromFile(): Promise<CatalogCacheFile | null> {
  try {
    if (!existsSync(CATALOG_CACHE_PATH)) return null;
    const raw = await readFile(CATALOG_CACHE_PATH, 'utf-8');
    return JSON.parse(raw) as CatalogCacheFile;
  } catch {
    return null;
  }
}

/**
 * Get the age of the catalog cache in human-readable format.
 */
export async function getCatalogCacheAge(): Promise<string | null> {
  const cache = await loadCatalogFromFile();
  if (!cache) return null;
  const ageMs = Date.now() - new Date(cache.savedAt).getTime();
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  return `${days} days ago`;
}

// ─── Native App Discovery ───────────────────────────────────

/**
 * Get all native apps from the AppMarket catalog.
 * Uses the catalog.native array directly.
 *
 * Falls back to cached catalog if live fetch fails.
 */
export async function getNativeApps(): Promise<MarketApp[]> {
  let catalog: Catalog;
  try {
    catalog = await fetchCatalog();
  } catch {
    // Fallback to cached catalog
    const cached = await loadCatalogFromFile();
    if (!cached) return [];
    catalog = cached.catalog;
  }

  const nativeApps: MarketApp[] = [];

  for (const entry of catalog.native) {
    try {
      const manifest = await fetchManifest(entry.id);
      nativeApps.push(manifestToMarketApp(manifest));
    } catch {
      // Skip apps that can't be fetched
    }
  }

  return nativeApps;
}

/**
 * Force refresh the catalog cache from remote.
 * Called by the "Refresh catalog" button in the App Market UI.
 */
export async function refreshCatalog(): Promise<Catalog> {
  clearCatalogCache();
  return fetchCatalog();
}
