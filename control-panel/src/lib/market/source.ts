import { mkdir, readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';

const MARKET_STATE_DIR = '/var/lib/youeye';
const MARKET_SOURCE_PATH = path.join(MARKET_STATE_DIR, 'market-source.json');

export const DEFAULT_MARKET_REPO_URL = 'https://github.com/youeye-platform/Market';

export interface MarketSource {
  repo_url: string;
  provider: 'github' | 'gitea';
  base_url: string;
  api_path: string;
  organization: string;
  repository: string;
}

interface StoredMarketSource {
  repo_url?: string;
}

function detectProvider(baseUrl: string): 'github' | 'gitea' {
  const host = new URL(baseUrl).hostname.toLowerCase();
  return host === 'github.com' || host.endsWith('.github.com') ? 'github' : 'gitea';
}

export function parseMarketRepoURL(repoUrl: string): MarketSource {
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

  return {
    repo_url: `${baseUrl}/${organization}/${repository}`,
    provider,
    base_url: baseUrl,
    api_path: provider === 'github' ? '' : '/api/v1',
    organization,
    repository,
  };
}

export async function getMarketSource(): Promise<MarketSource> {
  if (!existsSync(MARKET_SOURCE_PATH)) {
    return parseMarketRepoURL(DEFAULT_MARKET_REPO_URL);
  }

  const raw = JSON.parse(await readFile(MARKET_SOURCE_PATH, 'utf8')) as StoredMarketSource;
  return parseMarketRepoURL(raw.repo_url || DEFAULT_MARKET_REPO_URL);
}

export async function setMarketSource(repoUrl: string): Promise<MarketSource> {
  const source = parseMarketRepoURL(repoUrl);
  await mkdir(MARKET_STATE_DIR, { recursive: true });
  await writeFile(MARKET_SOURCE_PATH, JSON.stringify({ repo_url: source.repo_url }, null, 2) + '\n', 'utf8');
  return source;
}

export function isGitHubMarketSource(source: MarketSource): boolean {
  return source.provider === 'github';
}

export function buildMarketRawURL(source: MarketSource, owner: string, repo: string, filePath: string, branch: string): string {
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
  if (!isGitHubMarketSource(source) && asset.uuid) {
    return `${source.base_url}/attachments/${asset.uuid}`;
  }
  return asset.browser_download_url || null;
}
