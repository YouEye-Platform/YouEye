import { spineClient } from '@/lib/spine/client';

export interface ReleaseSource {
  provider: string;
  base_url: string;
  api_path: string;
  organization: string;
}

const DEFAULT_RELEASE_SOURCE: ReleaseSource = {
  provider: 'github',
  base_url: 'https://github.com',
  api_path: '',
  organization: 'YouEye-Platform',
};

export async function getReleaseSource(): Promise<ReleaseSource> {
  try {
    const config = await spineClient.getConfig();
    const source = config.release_source as Partial<ReleaseSource> | undefined;
    if (source?.base_url && source.organization) {
      return {
        provider: source.provider || 'gitea',
        base_url: source.base_url.replace(/\/$/, ''),
        api_path: source.api_path || '',
        organization: source.organization,
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
