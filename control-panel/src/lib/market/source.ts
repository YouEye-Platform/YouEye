import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';

const MARKET_STATE_DIR = '/var/lib/youeye';
const MARKET_SOURCES_PATH = path.join(MARKET_STATE_DIR, 'market-sources.json');

/**
 * Market sources.
 *
 * - The official Market (`kind: 'channel'`) is the `market` product of the
 *   box's channel index: a digest-bound `catalog.tar`. It has no repository,
 *   branch or commit of its own here; it always exists and can only be
 *   disabled.
 * - Custom sources (`kind: 'git'`) are repositories the owner added by URL.
 *   Their catalog and manifests are read as raw files from a branch.
 */
export interface MarketSource {
  id: string;
  name: string;
  kind: 'channel' | 'git';
  /** Repository URL of a custom source; empty for the official channel source. */
  repo_url: string;
  /** Branch of a custom source; empty for the official channel source. */
  branch: string;
  enabled: boolean;
  priority: number;
  trust: 'official' | 'community' | 'custom';
  provider: 'github' | 'gitea' | '';
  base_url: string;
  organization: string;
  repository: string;
  resolved_at?: string;
  refresh_error?: string;
}

interface StoredMarketSource {
  id?: string;
  name?: string;
  repo_url?: string;
  branch?: string;
  enabled?: boolean;
  priority?: number;
  trust?: 'official' | 'community' | 'custom';
  resolved_at?: string;
  refresh_error?: string;
}

export const OFFICIAL_MARKET_SOURCE_ID = 'official';
export const DEFAULT_MARKET_BRANCH = 'main';
const MARKET_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;

export function officialMarketSource(options: { enabled?: boolean; resolved_at?: string; refresh_error?: string } = {}): MarketSource {
  return {
    id: OFFICIAL_MARKET_SOURCE_ID,
    name: 'Official YouEye Market',
    kind: 'channel',
    repo_url: '',
    branch: '',
    enabled: options.enabled ?? true,
    priority: 0,
    trust: 'official',
    provider: '',
    base_url: '',
    organization: '',
    repository: '',
    resolved_at: options.resolved_at,
    refresh_error: options.refresh_error,
  };
}

export const isChannelMarketSource = (source: Pick<MarketSource, 'kind'>) => source.kind === 'channel';

function detectProvider(baseUrl: string): 'github' | 'gitea' {
  const host = new URL(baseUrl).hostname.toLowerCase();
  return host === 'github.com' || host.endsWith('.github.com') ? 'github' : 'gitea';
}

/** A custom (git) Market source added by URL. */
export function parseMarketRepoURL(
  repoUrl: string,
  options: {
    id?: string;
    name?: string;
    branch?: string;
    enabled?: boolean;
    priority?: number;
    trust?: 'official' | 'community' | 'custom';
    resolved_at?: string;
    refresh_error?: string;
  } = {}
): MarketSource {
  const trimmed = repoUrl.trim().replace(/\/$/, '').replace(/\.git$/, '');
  if (!trimmed) throw new Error('Market repo URL is required');

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('Market repo URL must be a valid URL');
  }

  if (parsed.protocol !== 'https:') throw new Error('Market repo URL must start with https://');

  const parts = parsed.pathname.replace(/^\/+|\/+$/g, '').split('/');
  if (parts.length < 2 || !parts[0] || !parts[1]) {
    throw new Error('Market repo URL must include owner and repository');
  }

  const baseUrl = `${parsed.protocol}//${parsed.host}`;
  const organization = parts[0];
  const repository = parts[1].replace(/\.git$/, '');

  const branch = (options.branch || DEFAULT_MARKET_BRANCH).trim() || DEFAULT_MARKET_BRANCH;
  if (!MARKET_REF_PATTERN.test(branch) || branch.includes('..') || branch.includes('//') || branch.endsWith('/')) {
    throw new Error('Market branch must be a safe branch name');
  }

  return {
    id: options.id || 'custom',
    name: options.name || repository,
    kind: 'git',
    repo_url: `${baseUrl}/${organization}/${repository}`,
    branch,
    enabled: options.enabled ?? true,
    priority: options.priority ?? 1,
    trust: options.trust === 'community' ? 'community' : 'custom',
    provider: detectProvider(baseUrl),
    base_url: baseUrl,
    organization,
    repository,
    resolved_at: options.resolved_at,
    refresh_error: options.refresh_error,
  };
}

async function atomicWriteJSON(filePath: string, value: unknown): Promise<void> {
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, filePath);
}

let marketSourceWriteChain = Promise.resolve();

function stored(source: MarketSource): StoredMarketSource {
  return source.kind === 'channel'
    ? { id: source.id, enabled: source.enabled, trust: 'official', resolved_at: source.resolved_at, refresh_error: source.refresh_error }
    : { id: source.id, name: source.name, repo_url: source.repo_url, branch: source.branch, enabled: source.enabled,
        priority: source.priority, trust: source.trust, resolved_at: source.resolved_at, refresh_error: source.refresh_error };
}

async function persistMarketSources(sources: MarketSource[]): Promise<void> {
  await mkdir(MARKET_STATE_DIR, { recursive: true });
  marketSourceWriteChain = marketSourceWriteChain.then(() =>
    atomicWriteJSON(MARKET_SOURCES_PATH, { active_sources: sources.map(stored) }));
  await marketSourceWriteChain;
}

function fromStored(entries: StoredMarketSource[]): MarketSource[] {
  const officialEntry = entries.find((entry) => entry.id === OFFICIAL_MARKET_SOURCE_ID || entry.trust === 'official' && !entry.repo_url);
  const custom = entries
    .filter((entry) => entry !== officialEntry && entry.id !== OFFICIAL_MARKET_SOURCE_ID && entry.trust !== 'official' && entry.repo_url)
    .map((entry, index) => parseMarketRepoURL(entry.repo_url!, {
      id: entry.id || `source-${index + 1}`,
      name: entry.name || `Market ${index + 1}`,
      branch: entry.branch,
      enabled: entry.enabled ?? true,
      priority: Math.max(1, entry.priority ?? index + 1),
      trust: entry.trust,
      resolved_at: entry.resolved_at,
      refresh_error: entry.refresh_error,
    }));
  return [officialMarketSource({ enabled: officialEntry?.enabled ?? true, resolved_at: officialEntry?.resolved_at, refresh_error: officialEntry?.refresh_error }), ...custom]
    .sort((a, b) => a.priority - b.priority);
}

/** The official source plus every custom source, in priority order. */
export async function getConfiguredMarketSources(): Promise<MarketSource[]> {
  if (!existsSync(MARKET_SOURCES_PATH)) return [officialMarketSource()];
  const raw = JSON.parse(await readFile(MARKET_SOURCES_PATH, 'utf8')) as { active_sources?: StoredMarketSource[] };
  return fromStored(Array.isArray(raw.active_sources) ? raw.active_sources : []);
}

export async function getMarketSources(): Promise<MarketSource[]> {
  return (await getConfiguredMarketSources()).filter((source) => source.enabled);
}

/** The primary source: the first enabled one, else the official source. */
export async function getMarketSource(): Promise<MarketSource> {
  return (await getMarketSources())[0] ?? officialMarketSource();
}

/** Replace the source list. The official source is always kept (it may be disabled). */
export async function setMarketSources(sources: StoredMarketSource[]): Promise<MarketSource[]> {
  const parsed = fromStored(sources);
  await persistMarketSources(parsed);
  return parsed;
}

export async function recordMarketSourceResolution(sourceId: string, result: { ok?: boolean; error?: string }): Promise<void> {
  const sources = await getConfiguredMarketSources();
  const updated = sources.map((source) => source.id === sourceId ? {
    ...source,
    ...(result.ok ? { resolved_at: new Date().toISOString() } : {}),
    refresh_error: result.error,
  } : source);
  await persistMarketSources(updated);
}

export function isGitHubMarketSource(source: MarketSource): boolean {
  return source.provider === 'github';
}

/** Raw file of a custom (git) source. Plain web paths, never a forge API. */
export function buildMarketRawURL(source: MarketSource, owner: string, repo: string, filePath: string, branch: string): string {
  if (source.kind !== 'git') throw new Error('The official Market is read from its catalog release, not from git');
  const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
  if (isGitHubMarketSource(source)) {
    return `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(branch)}/${encodedPath}`;
  }
  return `${source.base_url}/${owner}/${repo}/raw/branch/${branch.split('/').map(encodeURIComponent).join('/')}/${encodedPath}`;
}

/** The ref a custom catalog entry is read from. */
export function catalogEntryRef(entry: { repo?: string; branch?: string }, catalogRef: string): string {
  if (!entry.repo) return catalogRef;
  return entry.branch || DEFAULT_MARKET_BRANCH;
}
