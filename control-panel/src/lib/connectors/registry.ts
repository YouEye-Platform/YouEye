/**
 * Connector registry — fetches and caches connector manifests from YE-AppMarket.
 *
 * Follows the same pattern as the app catalog (lib/market/catalog.ts):
 * fetches YAML from the AppMarket Gitea repo, validates with Zod, caches in memory.
 */

import { parse as parseYAML } from 'yaml';
import { ConnectorManifestSchema, ConnectorCatalogSchema } from './schema';
import type { ConnectorManifest, ConnectorCatalog } from './schema';
import { settingsService } from '@/lib/settings';

const GITEA_BASE = 'https://git.byka.wtf';
const REPO_OWNER = 'potemsla';
const REPO_NAME = 'YE-AppMarket';
const DEFAULT_BRANCH = 'main';

async function getEffectiveBranch(): Promise<string> {
  try {
    const config = await settingsService.getRaw();
    return config.release_branch || DEFAULT_BRANCH;
  } catch {
    return DEFAULT_BRANCH;
  }
}

function rawUrl(filePath: string, branch: string): string {
  return `${GITEA_BASE}/${REPO_OWNER}/${REPO_NAME}/raw/branch/${branch}/${filePath}`;
}

async function fetchFile(filePath: string): Promise<string> {
  const branch = await getEffectiveBranch();
  const url = rawUrl(filePath, branch);
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });

  if (!res.ok && branch !== DEFAULT_BRANCH) {
    const fallbackUrl = rawUrl(filePath, DEFAULT_BRANCH);
    const fallbackRes = await fetch(fallbackUrl, { signal: AbortSignal.timeout(15_000) });
    if (!fallbackRes.ok) throw new Error(`Failed to fetch ${filePath}: ${fallbackRes.status}`);
    return fallbackRes.text();
  }

  if (!res.ok) throw new Error(`Failed to fetch ${filePath}: ${res.status}`);
  return res.text();
}

// ─── In-memory cache ───────────────────────────────────────

let catalogCache: ConnectorCatalog | null = null;
let catalogCacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

const manifestCache = new Map<string, { manifest: ConnectorManifest; fetchedAt: number }>();

/**
 * Fetch the connector catalog from YE-AppMarket/connector-catalog.yaml
 */
export async function fetchConnectorCatalog(): Promise<ConnectorCatalog> {
  if (catalogCache && Date.now() - catalogCacheTime < CACHE_TTL) {
    return catalogCache;
  }

  const yamlText = await fetchFile('connector-catalog.yaml');
  const raw = parseYAML(yamlText);
  catalogCache = ConnectorCatalogSchema.parse(raw);
  catalogCacheTime = Date.now();
  return catalogCache;
}

/**
 * Fetch a single connector manifest by ID.
 */
export async function fetchConnectorManifest(connectorId: string): Promise<ConnectorManifest> {
  const cached = manifestCache.get(connectorId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
    return cached.manifest;
  }

  const catalog = await fetchConnectorCatalog();
  const entry = catalog.connectors.find((c) => c.id === connectorId);
  if (!entry) throw new Error(`Connector "${connectorId}" not found in catalog`);

  const filePath = entry.file || `connectors/${connectorId}/connector.yaml`;
  const yamlText = await fetchFile(filePath);
  const raw = parseYAML(yamlText);
  const manifest = ConnectorManifestSchema.parse(raw);

  if (manifest.metadata.id !== connectorId) {
    throw new Error(`Manifest ID "${manifest.metadata.id}" doesn't match "${connectorId}"`);
  }

  manifestCache.set(connectorId, { manifest, fetchedAt: Date.now() });
  return manifest;
}

/**
 * List all available connectors (optionally filtered by capability).
 */
export async function listConnectors(capability?: string): Promise<ConnectorManifest[]> {
  const catalog = await fetchConnectorCatalog();
  const manifests: ConnectorManifest[] = [];

  const results = await Promise.allSettled(
    catalog.connectors.map(async (entry) => fetchConnectorManifest(entry.id))
  );

  for (const result of results) {
    if (result.status === 'fulfilled') {
      const provides = result.value.metadata.provides;
      const capList = Array.isArray(provides) ? provides : [provides];
      if (!capability || capList.includes(capability)) {
        manifests.push(result.value);
      }
    }
  }

  return manifests;
}

/**
 * Find a connector that provides a specific capability.
 * Returns the first match (in catalog order).
 */
export async function findConnectorByCapability(capability: string): Promise<ConnectorManifest | null> {
  const connectors = await listConnectors(capability);
  return connectors[0] ?? null;
}

/**
 * Clear the connector cache. Called when catalog is updated.
 */
export function clearConnectorCache(): void {
  catalogCache = null;
  catalogCacheTime = 0;
  manifestCache.clear();
}
