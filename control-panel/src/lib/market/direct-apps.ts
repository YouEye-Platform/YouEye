import { createHash } from 'node:crypto';

import { readJSON, writeJSON, statePath } from '@/lib/storage/json-store';
import { manifestToMarketApp } from './catalog';
import type { AppManifest, MarketApp } from './types';
import { parse as parseYAML } from 'yaml';
import { AppManifestSchema } from './schema';

const STORE_PATH = statePath('direct-market-apps.json');

export interface DirectMarketApp {
  sourceId: string;
  manifestUrl: string;
  manifestDigest: string;
  manifest: AppManifest;
  addedAt: string;
  updatedAt: string;
}

interface DirectMarketAppStore {
  schemaVersion: 1;
  entries: Record<string, DirectMarketApp>;
}

function sourceIdFor(url: string): string {
  return `direct:${createHash('sha256').update(url).digest('hex').slice(0, 24)}`;
}

async function loadStore(): Promise<DirectMarketAppStore> {
  return await readJSON<DirectMarketAppStore>(STORE_PATH) ?? { schemaVersion: 1, entries: {} };
}

export async function saveDirectMarketApp(input: {
  manifestUrl: string;
  manifestText: string;
  manifest: AppManifest;
}): Promise<DirectMarketApp> {
  const manifestUrl = new URL(input.manifestUrl).toString();
  const sourceId = sourceIdFor(manifestUrl);
  const store = await loadStore();
  const existing = store.entries[sourceId];
  const now = new Date().toISOString();
  const entry: DirectMarketApp = {
    sourceId,
    manifestUrl,
    manifestDigest: createHash('sha256').update(input.manifestText).digest('hex'),
    manifest: input.manifest,
    addedAt: existing?.addedAt ?? now,
    updatedAt: now,
  };
  store.entries[sourceId] = entry;
  await writeJSON(STORE_PATH, store);
  return entry;
}

export async function listDirectMarketApps(): Promise<DirectMarketApp[]> {
  const store = await loadStore();
  return Object.values(store.entries).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function getDirectMarketApp(sourceId: string, appId?: string): Promise<DirectMarketApp | null> {
  if (!sourceId.startsWith('direct:')) return null;
  const entry = (await loadStore()).entries[sourceId] ?? null;
  if (entry && appId && entry.manifest.metadata.id !== appId) return null;
  return entry;
}

export async function removeDirectMarketApp(sourceId: string): Promise<boolean> {
  const store = await loadStore();
  if (!store.entries[sourceId]) return false;
  delete store.entries[sourceId];
  await writeJSON(STORE_PATH, store);
  return true;
}

export async function refreshDirectMarketApp(sourceId: string): Promise<DirectMarketApp> {
  const current = await getDirectMarketApp(sourceId);
  if (!current) throw new Error('Added app source no longer exists');
  const response = await fetch(current.manifestUrl, {
    headers: { Accept: 'text/yaml, application/yaml, text/plain', 'User-Agent': 'YouEye-Market/1.0' },
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Added app manifest returned HTTP ${response.status}`);
  if (response.headers.get('content-type')?.toLowerCase().includes('text/html')) {
    throw new Error('Added app manifest returned an HTML document');
  }
  const declared = Number(response.headers.get('content-length') || '0');
  if (declared > 1024 * 1024) throw new Error('Added app manifest exceeds 1 MiB');
  const manifestText = await response.text();
  if (manifestText.length === 0 || manifestText.length > 1024 * 1024) {
    throw new Error('Added app manifest is empty or exceeds 1 MiB');
  }
  const parsed = AppManifestSchema.safeParse(parseYAML(manifestText, { maxAliasCount: 0 }));
  if (!parsed.success) throw new Error('Added app manifest no longer validates');
  if (parsed.data.metadata.id !== current.manifest.metadata.id) {
    throw new Error('Added app source changed its app identity');
  }
  return saveDirectMarketApp({ manifestUrl: current.manifestUrl, manifestText, manifest: parsed.data });
}

export function directMarketAppToMarketApp(entry: DirectMarketApp): MarketApp {
  return {
    ...manifestToMarketApp(entry.manifest),
    catalogKey: `${entry.sourceId}:app:${entry.manifest.metadata.id}`,
    sourceId: entry.sourceId,
    sourceName: 'Added',
    sourceRepoUrl: entry.manifestUrl,
    manifestPath: entry.manifestUrl,
    manifestDigest: entry.manifestDigest,
  };
}

export async function listDirectMarketAppViews(): Promise<MarketApp[]> {
  return (await listDirectMarketApps()).map(directMarketAppToMarketApp);
}
