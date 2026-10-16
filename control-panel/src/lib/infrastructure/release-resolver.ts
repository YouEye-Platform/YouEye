import {
  buildReleasesAPIURL,
  getReleaseAssetDownloadURL,
  type ReleaseAsset,
  type ReleaseSource,
} from '../apps/release-source';
import { releaseCacheFetch } from '../releases/cache';
import { parseMarketRepoURL } from '../market/source';
import { canonicalCoreTag, loadSelectedCore } from '../releases/core-release';
import { compareVersions, parseReleaseVersion, parseVersionStrict } from '../version';

/** Per-component publisher overrides travel with their branch/tag/digest. */
export function infrastructureChannelSource(source: ReleaseSource, repository: string, channelSource?: string): { source: ReleaseSource; repository: string } {
  if (!channelSource) return { source, repository };
  const selected = new URL(channelSource);
  if (!['https:', 'http:'].includes(selected.protocol) || selected.username || selected.password || selected.search || selected.hash || !/^\/[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*\/?$/.test(selected.pathname)) {
    throw new Error('Infrastructure channel must identify one repository without credentials or query parameters');
  }
  const parsed = parseMarketRepoURL(channelSource);
  return { source: parsed, repository: parsed.repository };
}

const RELEASE_PAGE_SIZE = 50;
const MAX_RELEASE_PAGES = 100;

export type InfrastructureRelease = {
  tag_name: string;
  draft?: boolean;
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

export async function listInfrastructureReleases(
  source: ReleaseSource,
  repo: string,
  fetchImpl: FetchLike = releaseCacheFetch,
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
  let best: ResolvedInfrastructureRelease | null = null;

  for (const release of releases) {
    if (release.draft) continue;
    let version = '';
    if (branchPrefix && release.tag_name.startsWith(branchPrefix)) {
      version = release.tag_name.slice(branchPrefix.length);
    } else if (release.tag_name.startsWith(stablePrefix)) {
      version = release.tag_name.slice(stablePrefix.length);
      // An unqualified tag may advertise a reserved branch suffix. Never
      // compare a Beta/dev payload into Stable or guess a feature branch from
      // its display token; exact feature pins retain their raw source identity.
      const canonical = parseReleaseVersion(version);
      const token = branch === 'main' && source.provider === 'gitea' ? 'alpha' : branch;
      if (canonical?.token && (!['dev', 'alpha', 'beta'].includes(token) || canonical.token !== token)) continue;
    } else {
      continue;
    }

    if (!parseVersionStrict(version)) continue;
    const asset = release.assets?.find((candidate) => candidate.name === 'product-release.json')
      || release.assets?.find((candidate) => candidate.name === 'product-release.json.sig')
      || release.assets?.find((candidate) => candidate.name === 'standalone.tar');
    if (!asset) continue;
    const url = getReleaseAssetDownloadURL(source, asset, release.tag_name);
    if (!url) continue;

    if (!best || compareVersions(version, best.version) > 0) {
      best = { tag: release.tag_name, version, url };
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
  fetchImpl: FetchLike = releaseCacheFetch,
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
  const version = marker >= 0 ? exactTag.slice(marker + 2) : exactTag.startsWith('v') ? exactTag.slice(1) : '';
  if (!parseVersionStrict(version)) return null;
  return { tag: exactTag, version, url, artifactSHA256 };
}

export async function resolveExactInfrastructureStandaloneRelease(
  source: ReleaseSource,
  repo: string,
  exactTag: string,
  artifactSHA256: string,
  fetchImpl: FetchLike = fetch,
): Promise<ResolvedInfrastructureRelease> {
  if (canonicalCoreTag(exactTag)) {
    const selection = loadSelectedCore();
    const repository = `${source.base_url.replace(/\/$/, '')}/${source.organization}/${repo}`;
    const member = selection.members.find(m => m.role === 'ui' && m.source === repository && m.tag === exactTag && m.artifact.sha256 === artifactSHA256);
    if (!member || member.artifact.name !== 'standalone.tar') throw new Error('UI channel differs from frozen core selection');
    return {tag: member.tag, version: member.build_version, url: member.artifact.url, artifactSHA256};
  }
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
