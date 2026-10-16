import { ownerReleaseGrant } from '@/lib/releases/owner-trust';
import { execFile } from 'node:child_process';
import { createHash, createPublicKey } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { isDeepStrictEqual, promisify } from 'node:util';

import {
  listInfrastructureReleases,
  selectInfrastructureStandaloneRelease,
} from '@/lib/infrastructure/release-resolver';
import type { ReleaseAsset, ReleaseSource } from '@/lib/apps/release-source';
import { releaseArtifactTrust, verifySignedReleaseArtifactBuffer } from '@/lib/releases/verify';
import { getReleaseAssetDownloadURL } from '@/lib/apps/release-source';
import { ProductAssetNotFound, loadProductRelease, loadProductBlob, productReceipt, type InstalledProductReceipt, type VerifiedProductRelease } from '@/lib/releases/product-release';
import { releaseCacheFetch } from '@/lib/releases/cache';
import { getMarketSource, getMarketSources, publicNativeManifestRepo, type MarketSource } from './source';
import type { AppManifest, ContainerSpec, InstallConfig } from './types';

const execFileAsync = promisify(execFile);
const MAX_ARTIFACT_BYTES = 256 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 100_000;
const MAX_ARCHIVE_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 2 * 1024 * 1024 * 1024;
const SIGNATURE_ASSETS = new Set([
  'SHA256SUMS',
  'SHA256SUMS.sig',
  'provenance.json',
  'sbom.spdx.json',
]);
const SIGNATURE_INDICATORS = new Set(['release-development.pub', 'release-public.pub', 'SHA256SUMS.sig']);

export type MarketNativeSignature =
  | { status: 'unsigned' }
  | { status: 'verified-development' | 'verified-stable' | 'verified-beta' | 'verified-custom'; keyId: string };

export interface StagedMarketNativeArtifact {
  containerName: string;
  path: string;
  tag: string;
  version: string;
  sourceRepo: string;
  artifactName: 'standalone.tar';
  artifactSHA256: string;
  artifactBytes: number;
  signature: MarketNativeSignature;
  productRelease?: InstalledProductReceipt;
  runtimeUUID?: string;
}

export interface StagedMarketNativeArtifacts {
  byContainerName: Map<string, StagedMarketNativeArtifact>;
  cleanup(): Promise<void>;
}

export interface MarketNativeStageOptions {
  releases?: Record<string, { tag: string; version: string; sourceRepo?: string }>;
  skipContainerNames?: string[];
}

export class MarketNativeArtifactPolicyError extends Error {
  override name = 'MarketNativeArtifactPolicyError';
}

export function classifyMarketNativeSignatureAssets(assetNames: Iterable<string>): 'unsigned' | 'complete' {
  const advertised = new Set(assetNames);
  const claimsSignature = [...SIGNATURE_INDICATORS].some((name) => advertised.has(name));
  if (!claimsSignature) return 'unsigned';
  const keys = ['release-development.pub', 'release-public.pub'].filter(name => advertised.has(name));
  if (keys.length > 1) throw new MarketNativeArtifactPolicyError('Native app release advertises conflicting signing keys');
  const present = [...SIGNATURE_ASSETS].filter((name) => advertised.has(name));
  if (keys.length !== 1 || present.length !== SIGNATURE_ASSETS.size) {
    throw new MarketNativeArtifactPolicyError('Native app release advertises an incomplete signature bundle');
  }
  return 'complete';
}

function releaseSourceFromMarket(source: MarketSource): ReleaseSource {
  return {
    provider: source.provider,
    base_url: source.base_url,
    api_path: source.api_path,
    organization: source.organization,
    repository: source.repository,
    repo_url: source.repo_url,
  };
}

function releaseSourceForRepo(repo: string, marketSource: MarketSource): { source: ReleaseSource; repo: string; identity: string } {
  const cleaned = repo.trim().replace(/\.git$/, '').replace(/\/$/, '');
  if (/^https:\/\//i.test(cleaned)) {
    const parsed = new URL(cleaned);
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error('Native app source repository URL cannot contain credentials or query data');
    }
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length !== 2) throw new Error('Native app source repository URL must name one owner and repository');
    return {
      source: {
        provider: parsed.hostname.toLowerCase() === 'github.com' ? 'github' : 'gitea',
        base_url: parsed.origin,
        api_path: parsed.hostname.toLowerCase() === 'github.com' ? '' : '/api/v1',
        organization: parts[0],
        repository: parts[1],
        repo_url: `${parsed.origin}/${parts[0]}/${parts[1]}`,
      },
      repo: parts[1],
      identity: `${parsed.origin}/${parts[0]}/${parts[1]}`,
    };
  }

  const parts = cleaned.split('/').filter(Boolean);
  if (parts.length > 2 || parts.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part))) {
    throw new Error('Native app source repository is malformed');
  }
  const owner = parts.length === 2 ? parts[0] : marketSource.organization;
  const repoName = parts.at(-1);
  if (!repoName) throw new Error('Native app source repository is missing');
  const source = releaseSourceFromMarket({ ...marketSource, organization: owner });
  return {
    source,
    repo: repoName,
    identity: `${source.base_url.replace(/\/$/, '')}/${owner}/${repoName}`,
  };
}

async function selectedMarketSource(config: Pick<InstallConfig, 'sourceId' | 'sourceRepoUrl' | 'manifestBranch'>): Promise<MarketSource> {
  if (config.sourceId?.startsWith('direct:') && config.sourceRepoUrl) {
    const parsed = new URL(config.sourceRepoUrl);
    const parts = parsed.pathname.split('/').filter(Boolean);
    const apiRepo = parts[0] === 'api' && parts[1] === 'v1' && parts[2] === 'repos'
      ? { organization: parts[3], repository: parts[4] }
      : parts.length >= 2 ? { organization: parts[0], repository: parts[1] } : null;
    if (!apiRepo?.organization || !apiRepo.repository) {
      throw new Error('Direct manifest URL does not identify its repository');
    }
    const github = parsed.hostname.toLowerCase() === 'github.com' || parsed.hostname.toLowerCase() === 'raw.githubusercontent.com';
    const baseURL = github ? 'https://github.com' : parsed.origin;
    return {
      id: config.sourceId,
      name: 'Added',
      repo_url: `${baseURL}/${apiRepo.organization}/${apiRepo.repository}`,
      branch: parsed.searchParams.get('ref') || config.manifestBranch || 'main',
      enabled: true,
      priority: 0,
      trust: 'custom',
      provider: github ? 'github' : 'gitea',
      base_url: baseURL,
      api_path: github ? '' : '/api/v1',
      organization: apiRepo.organization,
      repository: apiRepo.repository,
    };
  }
  const { resolveCatalogDependencySource } = await import('./catalog-release');
  if (config.sourceId && !config.sourceId.startsWith('direct:')) {
    const configured = (await getMarketSources()).find((source) => source.id === config.sourceId);
    if (configured) return resolveCatalogDependencySource(configured);
  }
  return resolveCatalogDependencySource(await getMarketSource());
}

export async function downloadMarketNativeArtifact(url: string, fetchImpl: typeof fetch = releaseCacheFetch, maxBytes = MAX_ARTIFACT_BYTES): Promise<Buffer> {
  const initial = new URL(url);
  let current = initial;
  let response: Response | null = null;
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    response = await fetchImpl(current, {
      headers: { Accept: 'application/x-tar, application/octet-stream', 'User-Agent': 'youeye-control' },
      redirect: 'manual',
      signal: AbortSignal.timeout(120_000),
    });
    if (response.status < 300 || response.status >= 400) break;
    const location = response.headers.get('location');
    if (!location || redirects === 3) throw new MarketNativeArtifactPolicyError('Native app artifact redirect chain is invalid');
    const next = new URL(location, current);
    const githubAssetRedirect = initial.origin === 'https://github.com'
      && /^\/[^/]+\/[^/]+\/releases\/download\/[^/]+\/[^/]+$/.test(initial.pathname)
      && !initial.username && !initial.password && !initial.search && !initial.hash
      && next.origin === 'https://release-assets.githubusercontent.com';
    if ((!githubAssetRedirect && next.origin !== initial.origin) || next.username || next.password || next.hash) {
      throw new MarketNativeArtifactPolicyError('Native app artifact redirected outside its release source');
    }
    current = next;
  }
  if (!response) throw new MarketNativeArtifactPolicyError('Native app artifact request did not complete');
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 404) throw new ProductAssetNotFound('Original product artifact is not published');
    throw new MarketNativeArtifactPolicyError(`Native app artifact returned HTTP ${response.status}`);
  }
  const contentType = response.headers.get('content-type')?.toLowerCase() || '';
  if (contentType.includes('text/html')) throw new MarketNativeArtifactPolicyError('Native app artifact returned an HTML document');
  const declared = Number(response.headers.get('content-length') || '0');
  if (declared > maxBytes) throw new MarketNativeArtifactPolicyError(`Native app artifact exceeds the ${maxBytes / (1024 * 1024)} MiB limit`);
  if (!response.body) throw new MarketNativeArtifactPolicyError('Native app artifact response has no body');

  const chunks: Buffer[] = [];
  let total = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new MarketNativeArtifactPolicyError(`Native app artifact exceeds the ${maxBytes / (1024 * 1024)} MiB limit`);
    }
    chunks.push(Buffer.from(value));
  }
  if (total === 0) throw new MarketNativeArtifactPolicyError('Native app artifact is empty');
  return Buffer.concat(chunks, total);
}

export async function resolveMarketProductRelease(product: string, repository: string, tag: string): Promise<VerifiedProductRelease | null> {
  const { parseMarketRepoURL } = await import('./source');
  const source = parseMarketRepoURL(repository);
  const release = (await listInfrastructureReleases(source,source.repository)).find(r => r.tag_name === tag);
  if (!release) throw new MarketNativeArtifactPolicyError('Selected product release is unavailable');
  const url = `${repository}/releases/download/${tag}/product-release.json`;
  return loadProductRelease(release.assets.map(a => a.name),{product,source:repository,tag},
    (name,max) => downloadMarketNativeArtifact(selectedReleaseAssetTransport(source,release.assets,tag,url,name),releaseCacheFetch,max));
}

export async function downloadMarketProductBlob(selected: VerifiedProductRelease, name: string, maximum = 1024*1024): Promise<Buffer> {
  return loadProductBlob(selected,name,async (url,max) => {
    // Resolve a private mirror's attachment from its exact release listing;
    // Forgejo canonical links may otherwise resolve to repository HTML.
    if (url.startsWith(`${selected.release.source}/releases/download/${selected.release.tag}/blob-`)) {
      const { parseMarketRepoURL } = await import('./source');
      const source = parseMarketRepoURL(selected.release.source);
      const release = (await listInfrastructureReleases(source,source.repository)).find(r => r.tag_name === selected.release.tag);
      if (!release) throw new MarketNativeArtifactPolicyError('Selected product mirror is unavailable');
      const asset = new URL(url).pathname.split('/').at(-1)!;
      const transport = selectedReleaseAssetTransport(source,release.assets,selected.release.tag,url,asset);
      return downloadMarketNativeArtifact(transport,releaseCacheFetch,max);
    }
    return downloadMarketNativeArtifact(url,releaseCacheFetch,max);
  },maximum);
}

/** Compare installer semantics after the same bounded catalog presentation mapping.
 * The original signed bytes and build version remain the authority; a catalog
 * may resolve image paths and the known public repository projection only.
 */
export async function verifyMarketProductInstallContract(
  contract: Buffer, selected: VerifiedProductRelease, manifest: AppManifest,
  config: InstallConfig, source?: MarketSource,
): Promise<void> {
  if (createHash('sha256').update(contract).digest('hex') !== selected.build.contract_sha256) {
    throw new MarketNativeArtifactPolicyError('Product installer contract digest differs');
  }
  const { parseManifest } = await import('./parser');
  const original = parseManifest(contract.toString('utf8'));
  if (original.version !== selected.build.build_version || original.metadata.id !== selected.release.product) {
    throw new MarketNativeArtifactPolicyError('Product installer contract build identity differs');
  }
  if (!await sameMarketInstallContract(original, manifest, config, source)) {
    throw new MarketNativeArtifactPolicyError('Selected application manifest differs from signed product contract');
  }
}

export async function sameMarketInstallContract(
  original: AppManifest, manifest: AppManifest,
  config: Pick<InstallConfig, 'sourceId' | 'sourceRepoUrl' | 'manifestRepo' | 'manifestBranch' | 'manifestPath'>,
  source?: MarketSource,
): Promise<boolean> {
  original = structuredClone(original);
  const same = (expected: AppManifest) => isDeepStrictEqual({...expected, version: ''}, {...manifest, version: ''});
  if (same(original)) return true;
  if (config.manifestRepo && config.manifestBranch && !config.sourceId?.startsWith('direct:')) {
    const parts = config.manifestRepo.split('/');
    if (parts.length !== 2 || parts.some(part => !/^[A-Za-z0-9_.-]+$/.test(part))) {
      throw new MarketNativeArtifactPolicyError('Catalog manifest repository is invalid');
    }
    const marketSource = source || await selectedMarketSource(config);
    for (const container of original.containers) {
      if (container.type === 'lxd' && container.source) {
        container.source.repo = publicNativeManifestRepo(marketSource, config.manifestRepo, container.source.repo);
      }
    }
    // Per-app folders in the catalog use co-located images. Repository entries
    // retain their existing root-relative asset convention.
    const basePath = config.manifestRepo === `${marketSource.organization}/${marketSource.repository}`
      && /^apps\/[^/]+\/youeye-app\.yaml$/.test(config.manifestPath || '')
      ? posix.dirname(config.manifestPath!) : undefined;
    if (basePath && !original.metadata.iconUrl) original.metadata.iconUrl = 'icon.svg';
    const { resolveManifestPaths } = await import('./catalog');
    await resolveManifestPaths(original, parts[0], parts[1], config.manifestBranch, marketSource, basePath);
    if (same(original)) return true;
  }
  return false;
}

function selectedReleaseAssetTransport(
  source: ReleaseSource,
  assets: ReleaseAsset[],
  tag: string,
  artifactURL: string,
  name: string,
): string {
  const matches = assets.filter(asset => asset.name === name);
  if (matches.length !== 1) throw new MarketNativeArtifactPolicyError('Native app release asset is missing or ambiguous');
  const asset = matches[0];
  const canonical = getReleaseAssetDownloadURL(source, asset, tag);
  if (canonical !== new URL(name, artifactURL).toString()) {
    throw new MarketNativeArtifactPolicyError('Native app release asset does not match the selected repository and tag');
  }
  // Forgejo's canonical download route may redirect to repository HTML.
  // UUIDs come only from this selected release's validated API asset list.
  if (source.provider === 'gitea' && asset.uuid !== undefined) {
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(asset.uuid)) {
      throw new MarketNativeArtifactPolicyError('Native app release attachment identity is invalid');
    }
    return new URL(`/attachments/${asset.uuid}`, source.base_url).toString();
  }
  return canonical;
}

function safeArchivePath(value: string): boolean {
  if (!value || value.includes('\\') || value.includes('\0') || value.startsWith('/')) return false;
  const normalized = posix.normalize(value.replace(/^\.\//, ''));
  return normalized !== '..' && !normalized.startsWith('../') && normalized.length <= 512;
}

function safeArchiveLinkTarget(entry: string, target: string): boolean {
  if (!target || target.includes('\\') || target.includes('\0') || target.startsWith('/')) return false;
  if (/\p{Cc}/u.test(target)) return false;
  const normalizedEntry = posix.normalize(entry.replace(/^\.\//, ''));
  const resolvedTarget = posix.normalize(posix.join(posix.dirname(normalizedEntry), target));
  return safeArchivePath(resolvedTarget);
}

export async function inspectMarketNativeArchive(path: string, requiredEntrypoint: string): Promise<void> {
  const list = await execFileAsync('tar', ['-tf', path], {
    timeout: 30_000,
    maxBuffer: MAX_ARCHIVE_OUTPUT_BYTES,
    env: { ...process.env, LC_ALL: 'C' },
  });
  const entries = list.stdout.split('\n').filter(Boolean);
  if (entries.length === 0 || entries.length > MAX_ARCHIVE_ENTRIES) {
    throw new MarketNativeArtifactPolicyError('App package has an invalid number of files');
  }
  if (entries.some((entry) => !safeArchivePath(entry))) {
    throw new MarketNativeArtifactPolicyError('App package contains a file path that leaves the package');
  }
  const normalizedEntrypoint = requiredEntrypoint.replace(/^\.\//, '');
  if (!entries.some((entry) => entry.replace(/^\.\//, '').replace(/\/$/, '') === normalizedEntrypoint)) {
    throw new MarketNativeArtifactPolicyError(`App package is missing ${normalizedEntrypoint}`);
  }

  const verbose = await execFileAsync('tar', ['--numeric-owner', '-tvf', path], {
    timeout: 30_000,
    maxBuffer: MAX_ARCHIVE_OUTPUT_BYTES,
    env: { ...process.env, LC_ALL: 'C' },
  });
  const verboseEntries = verbose.stdout.split('\n').filter(Boolean);
  if (verboseEntries.length !== entries.length) {
    throw new MarketNativeArtifactPolicyError('App package file listings disagree');
  }
  let expandedBytes = 0;
  for (const [index, line] of verboseEntries.entries()) {
    const type = line[0];
    if (type === 'l') {
      const linkMarker = line.indexOf(' -> ');
      const target = linkMarker >= 0 ? line.slice(linkMarker + 4) : '';
      if (!safeArchiveLinkTarget(entries[index], target)) {
        throw new MarketNativeArtifactPolicyError('App package contains a symbolic link that leaves the package');
      }
    } else if (type !== '-' && type !== 'd') {
      throw new MarketNativeArtifactPolicyError('App package contains a hard link or unsupported special file');
    }
    const match = /^\S+\s+\S+\s+(\d+)\s+/.exec(line);
    if (!match) throw new MarketNativeArtifactPolicyError('App package file listing is malformed');
    expandedBytes += Number(match[1]);
    if (!Number.isSafeInteger(expandedBytes) || expandedBytes > MAX_EXPANDED_BYTES) {
      throw new MarketNativeArtifactPolicyError('App package expands beyond the 2 GiB limit');
    }
  }
}

/** Shared signed native archive staging for Market apps and managed Pointer. */
export async function stageVerifiedProductArtifact(directory: string, containerName: string, assembly: VerifiedProductRelease, expectedDigest?: string): Promise<StagedMarketNativeArtifact> {
  if (assembly.build.kind !== 'native' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(containerName)) throw new MarketNativeArtifactPolicyError('Invalid native product staging identity');
  const load = (name: string, maximum = 1024*1024) => downloadMarketProductBlob(assembly,name,maximum);
  if (assembly.release.product === 'pointer') {
    const contract = await load('pointer-build-contract.json');
    if (createHash('sha256').update(contract).digest('hex') !== assembly.build.contract_sha256) throw new MarketNativeArtifactPolicyError('Pointer build contract differs');
  }
  const bytes = await load('standalone.tar',MAX_ARTIFACT_BYTES);
  const originalURL = assembly.build.assets.find(a => a.name === 'standalone.tar')!.url;
  await verifySignedReleaseArtifactBuffer(originalURL,bytes,'standalone.tar',expectedDigest,'app',name => load(name));
  const trust = releaseArtifactTrust(originalURL,undefined,'app');
  const artifactPath = join(directory,`${containerName}.standalone.tar`);
  await writeFile(artifactPath,bytes,{mode:0o600});
  await inspectMarketNativeArchive(artifactPath,'server.js');
  return {containerName,path:artifactPath,tag:assembly.release.tag,version:assembly.release.version,
    sourceRepo:assembly.release.source,artifactName:'standalone.tar',artifactSHA256:createHash('sha256').update(bytes).digest('hex'),
    artifactBytes:bytes.length,signature:{status:`verified-${trust.class}`,keyId:assembly.build.signer_sha256},productRelease:productReceipt(assembly)};
}

export async function stageMarketNativeArtifact(
  directory: string,
  container: ContainerSpec,
  marketSource: MarketSource,
  override?: { tag: string; version: string; sourceRepo?: string },
  product?: string,
): Promise<StagedMarketNativeArtifact> {
  if (container.type !== 'lxd' || !container.source) throw new Error('Native app container source is missing');
  const resolvedRepo = releaseSourceForRepo(override?.sourceRepo || container.source.repo, marketSource);
  const releases = await listInfrastructureReleases(resolvedRepo.source, resolvedRepo.repo);
  const exactRelease = override ? releases.find((candidate) => candidate.tag_name === override.tag) : undefined;
  const exactAsset = exactRelease?.assets.find((asset) => asset.name === 'product-release.json')
    || exactRelease?.assets.find((asset) => asset.name === 'standalone.tar');
  const exactUrl = exactAsset ? getReleaseAssetDownloadURL(resolvedRepo.source, exactAsset, override?.tag) : null;
  const selected = override
    ? (exactRelease && exactUrl ? { tag: override.tag, version: override.version, url: exactUrl } : null)
    : selectInfrastructureStandaloneRelease(
        resolvedRepo.source,
        releases,
        container.source.tagPrefix || '',
        marketSource.branch || 'main',
      );
  if (!selected) throw new Error(`No standalone release is available for ${resolvedRepo.identity}`);
  const selectedRepo = new URL(selected.url).pathname.split('/')[2];
  if (resolvedRepo.source.provider === 'github'
    ? selectedRepo.toLowerCase() !== resolvedRepo.repo.toLowerCase()
    : selectedRepo !== resolvedRepo.repo) {
    throw new MarketNativeArtifactPolicyError('Native app release does not match the selected repository');
  }
  const release = releases.find((candidate) => candidate.tag_name === selected.tag);
  if (!release) throw new Error('Selected native app release disappeared during preflight');
  const transport = (name: string) => selectedReleaseAssetTransport(resolvedRepo.source, release.assets, selected.tag, selected.url, name);
  const assembly = await loadProductRelease(release.assets.map(a => a.name),
    {product:product || '',source:resolvedRepo.identity,tag:selected.tag},
    (name,max) => downloadMarketNativeArtifact(transport(name),releaseCacheFetch,max));
  if (assembly) {
    if (assembly.release.version !== selected.version || assembly.build.kind !== 'native') throw new MarketNativeArtifactPolicyError('Product selection differs from requested native app');
    return stageVerifiedProductArtifact(directory,container.name,assembly,container.source.artifactSHA256?.toLowerCase());
  }
  const signatureClassification = classifyMarketNativeSignatureAssets(release.assets.map((asset) => asset.name));
  const publisherGrant = ownerReleaseGrant(selected.url, 'app');
  if (publisherGrant && signatureClassification !== 'complete') throw new MarketNativeArtifactPolicyError('This app source requires its enrolled publisher signature');
  const tarAsset = release.assets.find((asset) => asset.name === 'standalone.tar');
  if (!tarAsset) throw new Error('Selected native app release has no standalone.tar asset');
  const assetTransport = (name: string) => selectedReleaseAssetTransport(
    resolvedRepo.source, release.assets, selected.tag, selected.url, name,
  );
  const artifactURL = assetTransport('standalone.tar');

  let trust: ReturnType<typeof releaseArtifactTrust> | undefined;
  if (signatureClassification === 'complete') {
    try {
      trust = releaseArtifactTrust(selected.url, undefined, 'app');
      if (!release.assets.some(asset => asset.name === trust!.name)) {
        throw new Error('Signature bundle does not match selected source authority');
      }
    } catch (cause) {
      throw new MarketNativeArtifactPolicyError('Native app signing authority is not supported for this source and channel', { cause });
    }
  }
  let bytes: Buffer;
  try { bytes = await downloadMarketNativeArtifact(artifactURL); }
  catch (cause) {
    if (cause instanceof MarketNativeArtifactPolicyError) throw cause;
    throw new MarketNativeArtifactPolicyError('Native app package download failed; retry when the release host is available', { cause });
  }
  const artifactSHA256 = createHash('sha256').update(bytes).digest('hex');
  const expectedDigest = container.source.artifactSHA256?.toLowerCase();
  if (expectedDigest && expectedDigest !== artifactSHA256) {
    throw new MarketNativeArtifactPolicyError('Native app artifact does not match the manifest SHA-256');
  }

  let signature: MarketNativeSignature = { status: 'unsigned' };
  if (signatureClassification === 'complete') {
    try {
      await verifySignedReleaseArtifactBuffer(selected.url, bytes, 'standalone.tar', expectedDigest, 'app',
        name => downloadMarketNativeArtifact(assetTransport(name), fetch, 1024 * 1024));
    }
    catch (cause) { throw new MarketNativeArtifactPolicyError('Native app signature or checksum verification failed', { cause }); }
    signature = { status: `verified-${trust!.class}`, keyId: publisherGrant ? createHash('sha256').update(createPublicKey(publisherGrant.public_key).export({type:'spki',format:'der'})).digest('hex') : `youeye-${trust!.class}-v1` };
  }

  const artifactPath = join(directory, `${container.name}.standalone.tar`);
  await writeFile(artifactPath, bytes, { mode: 0o600 });
  await inspectMarketNativeArchive(artifactPath, 'server.js');
  return {
    containerName: container.name,
    path: artifactPath,
    tag: selected.tag,
    version: selected.version,
    sourceRepo: resolvedRepo.identity,
    artifactName: 'standalone.tar',
    artifactSHA256,
    artifactBytes: bytes.byteLength,
    signature,
  };
}

export async function stageMarketNativeArtifacts(
  manifest: AppManifest,
  config: InstallConfig,
  options: MarketNativeStageOptions = {},
): Promise<StagedMarketNativeArtifacts> {
  const skipped = new Set(options.skipContainerNames ?? []);
  const nativeContainers = manifest.containers.filter((container) =>
    container.type === 'lxd' && !skipped.has(container.name)
  );
  const byContainerName = new Map<string, StagedMarketNativeArtifact>();
  if (nativeContainers.length === 0) return { byContainerName, cleanup: async () => undefined };

  const directory = await mkdtemp(join(tmpdir(), 'youeye-market-native-'));
  const marketSource = await selectedMarketSource(config);
  try {
    for (const container of nativeContainers) {
      const staged = await stageMarketNativeArtifact(directory, container, marketSource, options.releases?.[container.name],config.appId);
      byContainerName.set(container.name, staged);
    }
    return {
      byContainerName,
      cleanup: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function readStagedMarketNativeArtifact(artifact: StagedMarketNativeArtifact): Promise<Buffer> {
  const bytes = await readFile(artifact.path);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== artifact.artifactSHA256 || bytes.byteLength !== artifact.artifactBytes) {
    throw new Error('Staged native app artifact changed before deployment');
  }
  return bytes;
}
