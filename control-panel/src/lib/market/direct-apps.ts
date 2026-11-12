import { createHash } from 'node:crypto';

import { readJSON, writeJSON, statePath } from '@/lib/storage/json-store';
import { manifestToMarketApp } from './catalog';
import { loadApp } from './app-format/compile';
import { fetchUrlApp } from './url-app';
import type { AppManifest, FrozenAppSource, MarketApp } from './types';

const STORE_PATH = statePath('direct-market-apps.json');

export interface DirectMarketApp {
  sourceId: string;
  manifestUrl: string;
  manifestDigest: string;
  manifest: AppManifest;
  addedAt: string;
  updatedAt: string;
}

/** Stored entries keep the app source; the model is compiled from it on every read. */
interface StoredDirectMarketApp extends Omit<DirectMarketApp, 'manifest'> {
  source: Pick<FrozenAppSource, 'manifest' | 'setups'>;
}

interface DirectMarketAppStore {
  schemaVersion: 1;
  entries: Record<string, StoredDirectMarketApp>;
}

function compileEntry(entry: StoredDirectMarketApp): DirectMarketApp | null {
  try {
    const { source, ...rest } = entry;
    return { ...rest, manifest: loadApp(source) };
  } catch {
    return null;
  }
}

function sourceIdFor(url: string): string {
  return `direct:${createHash('sha256').update(url).digest('hex').slice(0, 24)}`;
}

async function loadStore(): Promise<DirectMarketAppStore> {
  return await readJSON<DirectMarketAppStore>(STORE_PATH) ?? { schemaVersion: 1, entries: {} };
}

export async function saveDirectMarketApp(input: {
  manifestUrl: string;
  manifest: AppManifest;
}): Promise<DirectMarketApp> {
  const manifestUrl = new URL(input.manifestUrl).toString();
  const frozen = input.manifest.frozen;
  if (!frozen) throw new Error('Added app has no manifest source');
  const sourceId = sourceIdFor(manifestUrl);
  const store = await loadStore();
  const existing = store.entries[sourceId];
  const now = new Date().toISOString();
  const entry: StoredDirectMarketApp = {
    sourceId,
    manifestUrl,
    manifestDigest: frozen.digest,
    source: { manifest: frozen.manifest, setups: frozen.setups },
    addedAt: existing?.addedAt ?? now,
    updatedAt: now,
  };
  store.entries[sourceId] = entry;
  await writeJSON(STORE_PATH, store);
  const { source: _source, ...rest } = entry;
  return { ...rest, manifest: input.manifest };
}

export async function listDirectMarketApps(): Promise<DirectMarketApp[]> {
  const store = await loadStore();
  return Object.values(store.entries)
    .map(compileEntry)
    .filter((entry): entry is DirectMarketApp => entry !== null)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function getDirectMarketApp(sourceId: string, appId?: string): Promise<DirectMarketApp | null> {
  if (!sourceId.startsWith('direct:')) return null;
  const stored = (await loadStore()).entries[sourceId];
  const entry = stored ? compileEntry(stored) : null;
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
  let manifest: AppManifest;
  try {
    manifest = await fetchUrlApp(current.manifestUrl);
  } catch (error) {
    throw new Error(`Added app manifest no longer validates: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (manifest.metadata.id !== current.manifest.metadata.id) {
    throw new Error('Added app source changed its app identity');
  }
  return saveDirectMarketApp({ manifestUrl: current.manifestUrl, manifest });
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
