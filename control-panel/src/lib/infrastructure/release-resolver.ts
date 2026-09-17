import {
  buildReleasesAPIURL,
  getReleaseAssetDownloadURL,
  type ReleaseAsset,
  type ReleaseSource,
} from '../apps/release-source';

const RELEASE_PAGE_SIZE = 50;
const MAX_RELEASE_PAGES = 100;

export type InfrastructureRelease = {
  tag_name: string;
  assets: ReleaseAsset[];
};

export type ResolvedInfrastructureRelease = {
  tag: string;
  version: string;
  url: string;
  artifactSHA256?: string;
};

type FetchLike = typeof fetch;

function safeExactReleaseTag(value: string): boolean {
  return value.length > 0 && value.length <= 180 && value.split('/').every((segment) =>
    /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(segment) &&
    segment !== '.' && segment !== '..' && !segment.startsWith('.') &&
    !segment.endsWith('.') && !segment.endsWith('.lock'));
}

function parseVersion(version: string): number[] | null {
  if (!/^\d+(?:\.\d+)*$/.test(version)) return null;
  return version.split('.').map(Number);
}

function compareVersions(left: number[], right: number[]): number {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] || 0) - (right[index] || 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export async function listInfrastructureReleases(
  source: ReleaseSource,
  repo: string,
  fetchImpl: FetchLike = fetch,
): Promise<InfrastructureRelease[]> {
  const releases: InfrastructureRelease[] = [];

  for (let page = 1; page <= MAX_RELEASE_PAGES; page += 1) {
    const response = await fetchImpl(buildReleasesAPIURL(source, repo, page, RELEASE_PAGE_SIZE), {
      headers: {
        Accept: source.provider === 'github' ? 'application/vnd.github+json' : 'application/json',
        'User-Agent': 'youeye-control',
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`Release API returned HTTP ${response.status} on page ${page}`);
    }

    const pageReleases = await response.json();
    if (!Array.isArray(pageReleases)) {
      throw new Error(`Release API page ${page} did not return an array`);
    }
    releases.push(...pageReleases as InfrastructureRelease[]);
    if (pageReleases.length < RELEASE_PAGE_SIZE) return releases;
  }

  throw new Error(`Release discovery exceeded ${MAX_RELEASE_PAGES} pages`);
}

export function selectInfrastructureStandaloneRelease(
  source: ReleaseSource,
  releases: InfrastructureRelease[],
  tagPrefix: string,
  branch: string,
): ResolvedInfrastructureRelease | null {
  const branchPrefix = branch && branch !== 'main'
    ? (tagPrefix ? `${tagPrefix}-${branch}-v` : `${branch}-v`)
    : '';
  const stablePrefix = tagPrefix ? `${tagPrefix}-v` : 'v';
  let best: (ResolvedInfrastructureRelease & { parsed: number[] }) | null = null;

  for (const release of releases) {
    let version = '';
    if (branchPrefix && release.tag_name.startsWith(branchPrefix)) {
      version = release.tag_name.slice(branchPrefix.length);
    } else if (release.tag_name.startsWith(stablePrefix)) {
      version = release.tag_name.slice(stablePrefix.length);
    } else {
      continue;
    }

    const parsed = parseVersion(version);
    if (!parsed) continue;
    const asset = release.assets?.find((candidate) => candidate.name === 'standalone.tar');
    if (!asset) continue;
    const url = getReleaseAssetDownloadURL(source, asset, release.tag_name);
    if (!url) continue;

    if (!best || compareVersions(parsed, best.parsed) > 0) {
      best = { tag: release.tag_name, version, url, parsed };
    }
  }

  if (!best) return null;
  return { tag: best.tag, version: best.version, url: best.url };
}

export async function resolveInfrastructureStandaloneRelease(
  source: ReleaseSource,
  repo: string,
  tagPrefix: string,
  branch: string,
  fetchImpl: FetchLike = fetch,
): Promise<ResolvedInfrastructureRelease> {
  const releases = await listInfrastructureReleases(source, repo, fetchImpl);
  const resolved = selectInfrastructureStandaloneRelease(source, releases, tagPrefix, branch);
  if (!resolved) {
    throw new Error(
      `No ${tagPrefix} standalone release found for branch ${branch || 'main'} across ${releases.length} releases`,
    );
  }
  return resolved;
}

/** Resolve one immutable signed release identity without branch fallback. */
export function selectExactInfrastructureStandaloneRelease(
  source: ReleaseSource,
  releases: InfrastructureRelease[],
  exactTag: string,
  artifactSHA256: string,
): ResolvedInfrastructureRelease | null {
  if (!safeExactReleaseTag(exactTag) || !/^[0-9a-f]{64}$/.test(artifactSHA256)) {
    return null;
  }
  const release = releases.find((candidate) => candidate.tag_name === exactTag);
  const asset = release?.assets?.find((candidate) => candidate.name === 'standalone.tar');
  if (!asset) return null;
  const url = getReleaseAssetDownloadURL(source, asset, exactTag);
  if (!url) return null;
  const marker = exactTag.lastIndexOf('-v');
  const version = marker >= 0 ? exactTag.slice(marker + 2) : '';
  if (!parseVersion(version)) return null;
  return { tag: exactTag, version, url, artifactSHA256 };
}

export async function resolveExactInfrastructureStandaloneRelease(
  source: ReleaseSource,
  repo: string,
  exactTag: string,
  artifactSHA256: string,
  fetchImpl: FetchLike = fetch,
): Promise<ResolvedInfrastructureRelease> {
  // Exact tag plus digest already identifies the artifact. Signature and digest
  // verification remain mandatory at download; API discovery adds no trust.
  const direct = `${source.base_url.replace(/\/$/, '')}/${encodeURIComponent(source.organization)}/${encodeURIComponent(repo)}/releases/download/${encodeURIComponent(exactTag)}/standalone.tar`;
  const resolved = selectExactInfrastructureStandaloneRelease(source, [{
    tag_name: exactTag, assets: [{ name: 'standalone.tar', browser_download_url: direct }],
  }], exactTag, artifactSHA256);
  void fetchImpl;
  if (!resolved) {
    throw new Error(`Exact signed standalone release ${exactTag} was not found or did not match its configured identity`);
  }
  return resolved;
}
