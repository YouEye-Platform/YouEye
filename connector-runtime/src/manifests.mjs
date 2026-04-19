/**
 * Connector manifest registry — fetches and caches manifests from YE-AppMarket.
 * Serves GET /manifests and GET /manifests?id=xxx
 */

import yaml from 'js-yaml';

const GITEA_BASE = process.env.GITEA_BASE_URL || 'https://git.byka.wtf';
const REPO_OWNER = 'potemsla';
const REPO_NAME = 'YE-AppMarket';
const BRANCH = process.env.RELEASE_BRANCH || 'main';
const CACHE_TTL = 5 * 60 * 1000;

let catalogCache = null;
let catalogCacheTime = 0;
const manifestCache = new Map();

function rawUrl(filePath) {
  return `${GITEA_BASE}/${REPO_OWNER}/${REPO_NAME}/raw/branch/${BRANCH}/${filePath}`;
}

async function fetchFile(filePath) {
  const url = rawUrl(filePath);
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Failed to fetch ${filePath}: ${res.status}`);
  return res.text();
}

async function getCatalog() {
  if (catalogCache && Date.now() - catalogCacheTime < CACHE_TTL) return catalogCache;
  const text = await fetchFile('connector-catalog.yaml');
  catalogCache = yaml.load(text);
  catalogCacheTime = Date.now();
  return catalogCache;
}

async function getManifest(connectorId) {
  const cached = manifestCache.get(connectorId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) return cached.manifest;

  const catalog = await getCatalog();
  const entry = catalog.connectors?.find((c) => c.id === connectorId);
  if (!entry) throw new Error(`Connector "${connectorId}" not in catalog`);

  // Support both file-based (single YAML) and directory-based (connector.yaml inside dir)
  const filePath = entry.file || `connectors/${connectorId}/connector.yaml`;
  const text = await fetchFile(filePath);
  const manifest = yaml.load(text);

  manifestCache.set(connectorId, { manifest, fetchedAt: Date.now() });
  return manifest;
}

export async function handleManifests(req, res, url, sendJSON) {
  const id = url.searchParams.get('id');

  try {
    if (id) {
      const manifest = await getManifest(id);
      return sendJSON(res, 200, { ok: true, manifest });
    }

    const catalog = await getCatalog();
    const manifests = [];
    for (const entry of catalog.connectors || []) {
      try {
        const m = await getManifest(entry.id);
        manifests.push(m);
      } catch { /* skip broken manifests */ }
    }
    return sendJSON(res, 200, { ok: true, connectors: manifests });
  } catch (err) {
    return sendJSON(res, 500, { ok: false, error: err.message });
  }
}

export { getManifest, getCatalog };
