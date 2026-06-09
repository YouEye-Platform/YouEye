import { spineClient } from '@/lib/spine/client';

export interface ReleaseSource {
  repo_url?: string;
  provider: string;
  base_url: string;
  api_path: string;
  organization: string;
  repository?: string;
}

const DEFAULT_RELEASE_SOURCE: ReleaseSource = {
  provider: 'github',
  base_url: 'https://github.com',
  api_path: '',
  organization: 'youeye-platform',
  repository: 'YouEye',
};

function parseRepoURL(repoUrl: string): ReleaseSource {
  const parsed = new URL(repoUrl.trim().replace(/\/$/, '').replace(/\.git$/, ''));
  const parts = parsed.pathname.replace(/^\/+|\/+$/g, '').split('/');
  if (parts.length < 2 || !parts[0] || !parts[1]) {
    throw new Error('release_source.repo_url must include owner and repository');
  }
  const baseUrl = `${parsed.protocol}//${parsed.host}`;
  const isGitHub = parsed.hostname.toLowerCase() === 'github.com';
  return {
    repo_url: `${baseUrl}/${parts[0]}/${parts[1]}`,
    provider: isGitHub ? 'github' : 'gitea',
    base_url: baseUrl,
    api_path: isGitHub ? '' : '/api/v1',
    organization: parts[0],
    repository: parts[1],
  };
}

export async function getReleaseSource(): Promise<ReleaseSource> {
  try {
    const config = await spineClient.getConfig();
    const source = config.release_source as Partial<ReleaseSource> | undefined;
    if (source?.repo_url) {
      return parseRepoURL(source.repo_url);
    }
    if (source?.base_url && source.organization) {
      return {
        provider: source.provider || 'gitea',
        base_url: source.base_url.replace(/\/$/, ''),
        api_path: source.api_path || '',
        organization: source.organization,
        repository: source.repository,
      };
    }
  } catch (err) {
    console.warn('[release-source] Failed to read Spine release source:', err);
  }

  return DEFAULT_RELEASE_SOURCE;
}

export function buildReleasesAPIURL(source: ReleaseSource, repo: string): string {
  if (source.provider === 'github' || source.base_url === 'https://github.com') {
    return `https://api.github.com/repos/${source.organization}/${repo}/releases?per_page=50`;
  }

  const apiPath = source.api_path || '/api/v1';
  return `${source.base_url}${apiPath}/repos/${source.organization}/${repo}/releases?limit=50`;
}

export interface ReleaseAsset {
  name: string;
  browser_download_url?: string;
  uuid?: string;
}

export function getReleaseAssetDownloadURL(source: ReleaseSource, asset: ReleaseAsset): string | null {
  if (
    source.provider !== 'github' &&
    source.base_url !== 'https://github.com' &&
    asset.uuid
  ) {
    return `${source.base_url}/attachments/${asset.uuid}`;
  }

  return asset.browser_download_url || null;
}
