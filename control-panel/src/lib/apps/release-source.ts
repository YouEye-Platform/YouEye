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

export function buildReleasesAPIURL(source: ReleaseSource, repo: string, page = 1, perPage = 50): string {
  if (source.provider === 'github' || source.base_url === 'https://github.com') {
    return `https://api.github.com/repos/${source.organization}/${repo}/releases?per_page=${perPage}&page=${page}`;
  }

  const apiPath = source.api_path || '/api/v1';
  return `${source.base_url}${apiPath}/repos/${source.organization}/${repo}/releases?limit=${perPage}&page=${page}`;
}

export function buildRepositoryURL(source: ReleaseSource, repo: string): string {
  return `${source.base_url.replace(/\/$/, '')}/${source.organization}/${repo}`;
}

export interface ReleaseAsset {
  name: string;
  browser_download_url?: string;
  uuid?: string;
}

const SAFE_RELEASE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;

function safeReleaseTag(value: string): boolean {
  return value.length <= 180 && value.split('/').every((segment) =>
    SAFE_RELEASE_SEGMENT.test(segment) && segment !== '.' && segment !== '..' &&
    !segment.startsWith('.') && !segment.endsWith('.') && !segment.endsWith('.lock'));
}

export function getReleaseAssetDownloadURL(source: ReleaseSource, asset: ReleaseAsset, expectedTag?: string): string | null {
  // Signed-release verification fetches SHA256SUMS and its signature as
  // siblings of the artifact URL. Forgejo's opaque /attachments/<uuid> route
  // can download the artifact but cannot identify those release siblings.
  // browser_download_url retains the /releases/download/<tag>/<asset> identity.
  if (!asset.browser_download_url || !SAFE_RELEASE_SEGMENT.test(asset.name)) return null;

  try {
    const configuredOrigin = new URL(source.base_url).origin;
    const selected = new URL(asset.browser_download_url);
    if (
      selected.origin !== configuredOrigin ||
      selected.username ||
      selected.password ||
      selected.search ||
      selected.hash ||
      selected.pathname.includes('\\')
    ) {
      return null;
    }

    const segments = selected.pathname.split('/').filter(Boolean);
    if (
      segments.length < 6 ||
      segments[0] !== source.organization ||
      !SAFE_RELEASE_SEGMENT.test(segments[1]) ||
      segments[2] !== 'releases' ||
      segments[3] !== 'download' ||
      segments.at(-1) !== asset.name
    ) {
      return null;
    }
    const encodedTag = segments.slice(4, -1).join('/');
    if (/%(?!2f)/i.test(encodedTag)) return null;
    // A slash-bearing tag is only unambiguous when the caller already knows
    // the exact API release identity it selected. Generic consumers must not
    // infer that identity from an encoded path separator.
    if (expectedTag === undefined && /%2f|\//i.test(encodedTag)) return null;
    const tag = decodeURIComponent(encodedTag);
    if (!safeReleaseTag(tag) || (expectedTag !== undefined && tag !== expectedTag)) return null;
    return selected.toString();
  } catch {
    return null;
  }
}
