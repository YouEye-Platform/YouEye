import { releaseCacheFetch } from '@/lib/releases/cache';
import { buildReleasesAPIURL, getReleaseAssetDownloadURL, type ReleaseSource, type ReleaseAsset } from './release-source';

/** Resolve an exact selected tag through the protected release transport. */
export async function resolveExactLxdRelease(releaseSource: ReleaseSource, repo: string, tag: string, fetchImpl: typeof fetch = releaseCacheFetch): Promise<string | null> {
  // Pagination also supports protected candidate caches with a terminating page.
  for (let page = 1; page <= 200; page++) {
    const response = await fetchImpl(buildReleasesAPIURL(releaseSource, repo, page), { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Exact release lookup returned HTTP ${response.status}`);
    const releases = await response.json();
    if (!Array.isArray(releases)) throw new Error('Invalid release response');
    const match = releases.find((release: { tag_name?: string; draft?: boolean }) => release.tag_name === tag && !release.draft);
    if (match) {
      const asset = (match.assets as ReleaseAsset[] | undefined)?.find(asset => asset.name === 'standalone.tar');
      return asset ? getReleaseAssetDownloadURL(releaseSource, asset, tag) : null;
    }
    if (releases.length < 50) return null;
  }
  throw new Error('Exact release lookup exceeded pagination limit');
}

