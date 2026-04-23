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
import { parseCatalog, parseManifest } from './parser';
import type { AppManifest, Catalog, CatalogEntry, MarketApp } from './types';
import { settingsService } from '@/lib/settings';

const CATALOG_CACHE_DIR = '/var/lib/youeye';
const CATALOG_CACHE_PATH = path.join(CATALOG_CACHE_DIR, 'catalog-cache.json');

const GITEA_BASE = 'https://git.byka.wtf';
const REPO_OWNER = 'potemsla';
const REPO_NAME = 'YE-AppMarket';
const DEFAULT_BRANCH = 'main';

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

function rawUrl(filePath: string, branch: string): string {
  return `${GITEA_BASE}/${REPO_OWNER}/${REPO_NAME}/raw/branch/${branch}/${filePath}`;
}

export async function fetchFile(filePath: string, branch?: string): Promise<string> {
  const effectiveBranch = branch || DEFAULT_BRANCH;
  const url = rawUrl(filePath, effectiveBranch);
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });

  if (!res.ok && effectiveBranch !== DEFAULT_BRANCH) {
    const fallbackUrl = rawUrl(filePath, DEFAULT_BRANCH);
    const fallbackRes = await fetch(fallbackUrl, { signal: AbortSignal.timeout(15_000) });
    if (!fallbackRes.ok) throw new Error(`Failed to fetch ${filePath}: ${fallbackRes.status}`);
    return fallbackRes.text();
  }

  if (!res.ok) throw new Error(`Failed to fetch ${filePath}: ${res.status}`);
  return res.text();
}

export async function fetchRepoFile(owner: string, repo: string, filePath: string, branch: string): Promise<string> {
  const url = `${GITEA_BASE}/${owner}/${repo}/raw/branch/${branch}/${filePath}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });

  if (!res.ok && branch !== DEFAULT_BRANCH) {
    const fallbackUrl = `${GITEA_BASE}/${owner}/${repo}/raw/branch/${DEFAULT_BRANCH}/${filePath}`;
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

const manifestCache = new Map<string, { manifest: AppManifest; fetchedAt: number }>();

export async function fetchCatalog(): Promise<Catalog> {
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

  let manifest: AppManifest;
  let resolveOwner = REPO_OWNER;
  let resolveRepo = REPO_NAME;

  if (entry.repo) {
    const [owner, repoName] = entry.repo.split('/');
    resolveOwner = owner;
    resolveRepo = repoName;
    const manifestFile = entry.manifest || 'youeye-app.yaml';
    const yamlText = await fetchRepoFile(owner, repoName, manifestFile, branch);
    manifest = parseManifest(yamlText);
  } else if (entry.file) {
    const yamlText = await fetchFile(entry.file, branch);
    manifest = parseManifest(yamlText);
  } else {
    throw new Error(`Catalog entry for "${appId}" has neither repo nor file`);
  }

  resolveManifestPaths(manifest, resolveOwner, resolveRepo, branch);
  manifestCache.set(appId, { manifest, fetchedAt: Date.now() });
  return manifest;
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
    // Format: "potemsla/YE-App-Wiki"
    [owner, repo] = repoUrl.split('/');
  } else {
    // Full URL: extract owner/repo
    const match = repoUrl.match(/git\.byka\.wtf\/([^/]+)\/([^/]+)/);
    if (!match) throw new Error(`Cannot parse repo URL: ${repoUrl}`);
    owner = match[1];
    repo = match[2].replace(/\.git$/, '');
  }

  const effectiveBranch = branch || await getEffectiveBranch();
  const yamlText = await fetchRepoFile(owner, repo, manifestFile, effectiveBranch);
  const manifest = parseManifest(yamlText);
  resolveManifestPaths(manifest, owner, repo, effectiveBranch);
  return manifest;
}

// ─── Image Proxy ──────────────────────────────────────────

function proxyImageUrl(url: string): string {
  if (!url) return url;
  return `/api/market/image?url=${encodeURIComponent(url)}`;
}

function resolveManifestPaths(manifest: AppManifest, owner: string, repo: string, branch: string): void {
  const baseUrl = `${GITEA_BASE}/${owner}/${repo}/raw/branch/${branch}`;

  if (manifest.metadata.iconUrl && !manifest.metadata.iconUrl.startsWith('http')) {
    manifest.metadata.iconUrl = `${baseUrl}/${manifest.metadata.iconUrl}`;
  }
  if (manifest.metadata.iconUrl) {
    manifest.metadata.iconUrl = proxyImageUrl(manifest.metadata.iconUrl);
  }

  if (manifest.detail?.screenshots) {
    for (const screenshot of manifest.detail.screenshots) {
      if (screenshot.path && !screenshot.path.startsWith('http')) {
        screenshot.path = `${baseUrl}/${screenshot.path}`;
      }
      if (screenshot.path) {
        screenshot.path = proxyImageUrl(screenshot.path);
      }
    }
  }
}

// ─── MarketApp Conversion ─────────────────────────────────

function manifestToMarketApp(manifest: AppManifest): MarketApp {
  return {
    id: manifest.metadata.id,
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
    entrances: manifest.entrances,
    forwardAuth: manifest.forwardAuth,
    capabilities: manifest.capabilities ? {
      widgets: manifest.capabilities.widgets,
      notifications: manifest.capabilities.notifications,
      smtp: manifest.capabilities.smtp,
    } : undefined,
  };
}

// ─── Public API ───────────────────────────────────────────

export async function fetchAvailableApps(): Promise<MarketApp[]> {
  const catalog = await fetchCatalog();
  const apps: MarketApp[] = [];

  const results = await Promise.allSettled(
    catalog.apps.map(async (entry) => {
      const manifest = await fetchManifest(entry.id);
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
