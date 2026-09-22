import distributionPolicy from '../../../../releasecache/distribution-policy.json';
import { releaseCacheFetch } from '../releases/cache';
import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { getReleaseAssetDownloadURL } from '@/lib/apps/release-source';

const MARKET_STATE_DIR = '/var/lib/youeye';
const MARKET_SOURCE_PATH = path.join(MARKET_STATE_DIR, 'market-source.json');
const MARKET_SOURCES_PATH = path.join(MARKET_STATE_DIR, 'market-sources.json');

export const DEFAULT_MARKET_REPO_URL = 'https://github.com/YouEye-Platform/Market';

export interface MarketSource {
  id: string;
  name: string;
  repo_url: string;
  /** Branch the catalog + manifests are fetched from for this source (default "main"). */
  branch: string;
  enabled: boolean;
  priority: number;
  trust: 'official' | 'community' | 'custom';
  provider: 'github' | 'gitea';
  base_url: string;
  api_path: string;
  organization: string;
  repository: string;
  /** Last exact commit whose catalog parsed successfully. */
  resolved_commit?: string;
  resolved_at?: string;
  refresh_error?: string;
  /** Reproducible offline snapshot embedded in an appliance image. */
  bootstrap_commit?: string;
}

interface StoredMarketSource {
  id?: string;
  name?: string;
  repo_url?: string;
  branch?: string;
  enabled?: boolean;
  priority?: number;
  trust?: 'official' | 'community' | 'custom';
  resolved_commit?: string;
  resolved_at?: string;
  refresh_error?: string;
  bootstrap_commit?: string;
}

/** Default branch for a Market source when none is persisted. */
export const DEFAULT_MARKET_BRANCH = 'main';
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const MARKET_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const LEGACY_OFFICIAL_BOOTSTRAP_COMMITS = new Set([
  '7251b1587a724b74fa6e449acc79e2ec210b7df3',
  '470fb7aaeb57fc273efa8464ce22ea072cf3858e',
]);

interface StoredMarketSources {
  active_sources?: StoredMarketSource[];
}

function detectProvider(baseUrl: string): 'github' | 'gitea' {
  const host = new URL(baseUrl).hostname.toLowerCase();
  return host === 'github.com' || host.endsWith('.github.com') ? 'github' : 'gitea';
}

export function parseMarketRepoURL(
  repoUrl: string,
  options: {
    id?: string;
    name?: string;
    branch?: string;
    enabled?: boolean;
    priority?: number;
    trust?: 'official' | 'community' | 'custom';
    resolved_commit?: string;
    resolved_at?: string;
    refresh_error?: string;
    bootstrap_commit?: string;
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

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Market repo URL must start with http:// or https://');
  }

  const parts = parsed.pathname.replace(/^\/+|\/+$/g, '').split('/');
  if (parts.length < 2 || !parts[0] || !parts[1]) {
    throw new Error('Market repo URL must include owner and repository');
  }

  const baseUrl = `${parsed.protocol}//${parsed.host}`;
  const provider = detectProvider(baseUrl);
  const organization = parts[0];
  const repository = parts[1].replace(/\.git$/, '');

  const branch = (options.branch || DEFAULT_MARKET_BRANCH).trim() || DEFAULT_MARKET_BRANCH;
  if (!MARKET_REF_PATTERN.test(branch) || branch.includes('..') || branch.includes('//') || branch.endsWith('/')) {
    throw new Error('Market branch must be a safe branch name or full commit');
  }
  const resolvedCommit = options.resolved_commit?.trim();
  const bootstrapCommit = options.bootstrap_commit?.trim();
  if (resolvedCommit && !COMMIT_PATTERN.test(resolvedCommit)) {
    throw new Error('Market resolved commit must be a full lowercase Git commit');
  }
  if (bootstrapCommit && !COMMIT_PATTERN.test(bootstrapCommit)) {
    throw new Error('Market bootstrap commit must be a full lowercase Git commit');
  }

  return {
    id: options.id || 'official',
    name: options.name || 'Official YouEye Market',
    repo_url: `${baseUrl}/${organization}/${repository}`,
    branch,
    enabled: options.enabled ?? true,
    priority: options.priority ?? 0,
    trust: options.trust || 'official',
    provider,
    base_url: baseUrl,
    api_path: provider === 'github' ? '' : '/api/v1',
    organization,
    repository,
    resolved_commit: resolvedCommit,
    resolved_at: options.resolved_at,
    refresh_error: options.refresh_error,
    bootstrap_commit: bootstrapCommit,
  };
}

export function migrateLegacyOfficialSource(source: MarketSource): MarketSource {
  if (
    source.id === 'official' &&
    source.trust === 'official' &&
    source.repo_url === DEFAULT_MARKET_REPO_URL &&
    COMMIT_PATTERN.test(source.branch) &&
    (
      LEGACY_OFFICIAL_BOOTSTRAP_COMMITS.has(source.branch) ||
      source.bootstrap_commit === source.branch
    )
  ) {
    return {
      ...source,
      branch: DEFAULT_MARKET_BRANCH,
      resolved_commit: source.branch,
      bootstrap_commit: source.branch,
    };
  }
  return source;
}

async function atomicWriteJSON(filePath: string, value: unknown): Promise<void> {
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, filePath);
}

let marketSourceWriteChain = Promise.resolve();

async function persistMarketSources(sources: MarketSource[]): Promise<void> {
  await mkdir(MARKET_STATE_DIR, { recursive: true });
  marketSourceWriteChain = marketSourceWriteChain.then(async () => {
    await atomicWriteJSON(MARKET_SOURCES_PATH, { active_sources: sources });
    if (sources[0]) {
      await atomicWriteJSON(MARKET_SOURCE_PATH, sources[0]);
    }
  });
  await marketSourceWriteChain;
}

export async function getMarketSource(): Promise<MarketSource> {
  const sources = await getMarketSources();
  return sources[0] || parseMarketRepoURL(DEFAULT_MARKET_REPO_URL);
}

export async function getConfiguredMarketSources(): Promise<MarketSource[]> {
  if (existsSync(MARKET_SOURCES_PATH)) {
    const raw = JSON.parse(await readFile(MARKET_SOURCES_PATH, 'utf8')) as StoredMarketSources;
    const parsedSources = (raw.active_sources || [])
      .filter((entry) => entry.repo_url)
      .map((entry, index) => parseMarketRepoURL(entry.repo_url || DEFAULT_MARKET_REPO_URL, {
        id: entry.id || `source-${index + 1}`,
        name: entry.name || `Market ${index + 1}`,
        branch: entry.branch,
        enabled: entry.enabled ?? true,
        priority: entry.priority ?? index,
        trust: entry.trust || (index === 0 ? 'official' : 'custom'),
        resolved_commit: entry.resolved_commit,
        resolved_at: entry.resolved_at,
        refresh_error: entry.refresh_error,
        bootstrap_commit: entry.bootstrap_commit,
      }))
      .sort((a, b) => a.priority - b.priority);
    const sources = parsedSources.map(migrateLegacyOfficialSource);

    if (sources.length > 0) {
      if (sources.some((source, index) => source.branch !== parsedSources[index]?.branch)) {
        await persistMarketSources(sources);
      }
      return sources;
    }
  }

  if (!existsSync(MARKET_SOURCE_PATH)) {
    return [parseMarketRepoURL(DEFAULT_MARKET_REPO_URL)];
  }

  const raw = JSON.parse(await readFile(MARKET_SOURCE_PATH, 'utf8')) as StoredMarketSource;
  const parsed = parseMarketRepoURL(raw.repo_url || DEFAULT_MARKET_REPO_URL, {
    id: raw.id || 'official',
    name: raw.name || 'Official YouEye Market',
    branch: raw.branch,
    enabled: raw.enabled ?? true,
    priority: raw.priority ?? 0,
    trust: raw.trust || 'official',
    resolved_commit: raw.resolved_commit,
    resolved_at: raw.resolved_at,
    refresh_error: raw.refresh_error,
    bootstrap_commit: raw.bootstrap_commit,
  });
  const source = migrateLegacyOfficialSource(parsed);
  if (source.branch !== parsed.branch) await persistMarketSources([source]);
  return [source];
}

export async function getMarketSources(): Promise<MarketSource[]> {
  return (await getConfiguredMarketSources()).filter((source) => source.enabled);
}

export async function setMarketSource(repoUrl: string, branch?: string): Promise<MarketSource> {
  const source = parseMarketRepoURL(repoUrl, { branch });
  await persistMarketSources([source]);
  return source;
}

export async function setMarketSources(sources: StoredMarketSource[]): Promise<MarketSource[]> {
  const parsed = sources.map((source, index) => parseMarketRepoURL(source.repo_url || DEFAULT_MARKET_REPO_URL, {
    id: source.id || `source-${index + 1}`,
    name: source.name || `Market ${index + 1}`,
    branch: source.branch,
    enabled: source.enabled ?? true,
    priority: source.priority ?? index,
    trust: source.trust || (index === 0 ? 'official' : 'custom'),
    resolved_commit: source.resolved_commit,
    resolved_at: source.resolved_at,
    refresh_error: source.refresh_error,
    bootstrap_commit: source.bootstrap_commit,
  }));

  await persistMarketSources(parsed);
  return parsed.sort((a, b) => a.priority - b.priority);
}

export async function resolveMarketSourceCommit(
  source: MarketSource,
  fetchImpl: typeof fetch = releaseCacheFetch,
): Promise<string> {
  const encodedRef = encodeURIComponent(source.branch);
  const url = isGitHubMarketSource(source)
    ? `https://api.github.com/repos/${source.organization}/${source.repository}/commits/${encodedRef}`
    : `${source.base_url}${source.api_path}/repos/${source.organization}/${source.repository}/git/commits/${encodedRef}`;
  const response = await fetchImpl(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'youeye-control' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Market channel resolution returned HTTP ${response.status}`);
  const body = await response.json() as { sha?: string };
  const commit = body.sha?.trim().toLowerCase();
  if (!commit || !COMMIT_PATTERN.test(commit)) {
    throw new Error('Market channel resolution returned an invalid commit');
  }
  return commit;
}

export async function recordMarketSourceResolution(
  sourceId: string,
  result: { commit?: string; error?: string },
): Promise<void> {
  const sources = await getConfiguredMarketSources();
  const updated = sources.map((source) => source.id === sourceId ? {
    ...source,
    ...(result.commit ? { resolved_commit: result.commit, resolved_at: new Date().toISOString() } : {}),
    refresh_error: result.error,
  } : source);
  await persistMarketSources(updated);
}

export function isGitHubMarketSource(source: MarketSource): boolean {
  return source.provider === 'github';
}

export function hostedMarketRawURL(source: MarketSource, owner: string, repo: string, filePath: string, commit: string, policy = distributionPolicy): string | null {
  if (policy.origin !== 'https://releases.youeye.me' || !Object.keys(policy.keys).length || source.trust !== 'official'
    || source.provider !== 'github' || source.base_url !== 'https://github.com'
    || source.organization.toLowerCase() !== 'youeye-platform' || source.repository.toLowerCase() !== 'market'
    || owner.toLowerCase() !== 'youeye-platform' || repo.toLowerCase() !== 'market' || !COMMIT_PATTERN.test(commit)) return null;
  if (!/^[A-Za-z0-9_./-]+$/.test(filePath) || filePath.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('.'))) throw new Error('Unsafe hosted Market asset path');
  return `https://catalog.youeye.me/v1/snapshots/${commit}/${filePath}`;
}

export function buildMarketRawURL(source: MarketSource, owner: string, repo: string, filePath: string, branch: string): string {
  const hosted = hostedMarketRawURL(source, owner, repo, filePath, branch);
  if (hosted) return hosted;
  if (isGitHubMarketSource(source)) {
    return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filePath}`;
  }
  return `${source.base_url}${source.api_path}/repos/${owner}/${repo}/raw/${filePath}?ref=${encodeURIComponent(branch)}`;
}

export function buildMarketReleasesAPIURL(source: MarketSource, repo: string): string {
  if (isGitHubMarketSource(source)) {
    return `https://api.github.com/repos/${source.organization}/${repo}/releases?per_page=50`;
  }
  return `${source.base_url}${source.api_path}/repos/${source.organization}/${repo}/releases?limit=50`;
}

export interface MarketReleaseAsset {
  name: string;
  browser_download_url?: string;
  uuid?: string;
}

export function getMarketReleaseAssetDownloadURL(source: MarketSource, asset: MarketReleaseAsset): string | null {
  return getReleaseAssetDownloadURL(source, asset);
}

/** A Market commit belongs only to that repository, never to a referenced app repo. */
export function catalogEntryRef(entry: { repo?: string; branch?: string }, catalogRef: string, source: Pick<MarketSource, 'branch'>): string {
  if (!entry.repo) return catalogRef;
  if (entry.branch) return entry.branch;
  return COMMIT_PATTERN.test(source.branch) ? DEFAULT_MARKET_BRANCH : source.branch;
}
