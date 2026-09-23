import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { promisify } from 'node:util';

import {
  listInfrastructureReleases,
  selectInfrastructureStandaloneRelease,
} from '@/lib/infrastructure/release-resolver';
import type { ReleaseSource } from '@/lib/apps/release-source';
import { releaseArtifactTrust, verifySignedReleaseArtifactBuffer } from '@/lib/releases/verify';
import { getReleaseAssetDownloadURL } from '@/lib/apps/release-source';
import { getMarketSource, getMarketSources, type MarketSource } from './source';
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
  | { status: 'verified-development' | 'verified-stable' | 'verified-beta'; keyId: string };

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

async function selectedMarketSource(config: InstallConfig): Promise<MarketSource> {
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
  if (config.sourceId && !config.sourceId.startsWith('direct:')) {
    const configured = (await getMarketSources()).find((source) => source.id === config.sourceId);
    if (configured) return configured;
  }
  return getMarketSource();
}

export async function downloadMarketNativeArtifact(url: string, fetchImpl: typeof fetch = fetch): Promise<Buffer> {
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
  if (!response.ok) throw new MarketNativeArtifactPolicyError(`Native app artifact returned HTTP ${response.status}`);
  const contentType = response.headers.get('content-type')?.toLowerCase() || '';
  if (contentType.includes('text/html')) throw new MarketNativeArtifactPolicyError('Native app artifact returned an HTML document');
  const declared = Number(response.headers.get('content-length') || '0');
  if (declared > MAX_ARTIFACT_BYTES) throw new MarketNativeArtifactPolicyError('Native app artifact exceeds the 256 MiB limit');
  if (!response.body) throw new MarketNativeArtifactPolicyError('Native app artifact response has no body');

  const chunks: Buffer[] = [];
  let total = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_ARTIFACT_BYTES) {
      await reader.cancel();
      throw new MarketNativeArtifactPolicyError('Native app artifact exceeds the 256 MiB limit');
    }
    chunks.push(Buffer.from(value));
  }
  if (total === 0) throw new MarketNativeArtifactPolicyError('Native app artifact is empty');
  return Buffer.concat(chunks, total);
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

export async function stageMarketNativeArtifact(
  directory: string,
  container: ContainerSpec,
  marketSource: MarketSource,
  override?: { tag: string; version: string; sourceRepo?: string },
): Promise<StagedMarketNativeArtifact> {
  if (container.type !== 'lxd' || !container.source) throw new Error('Native app container source is missing');
  const resolvedRepo = releaseSourceForRepo(override?.sourceRepo || container.source.repo, marketSource);
  const releases = await listInfrastructureReleases(resolvedRepo.source, resolvedRepo.repo);
  const exactRelease = override ? releases.find((candidate) => candidate.tag_name === override.tag) : undefined;
  const exactAsset = exactRelease?.assets.find((asset) => asset.name === 'standalone.tar');
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
  const release = releases.find((candidate) => candidate.tag_name === selected.tag);
  if (!release) throw new Error('Selected native app release disappeared during preflight');
  const signatureClassification = classifyMarketNativeSignatureAssets(release.assets.map((asset) => asset.name));
  const tarAsset = release.assets.find((asset) => asset.name === 'standalone.tar');
  if (!tarAsset) throw new Error('Selected native app release has no standalone.tar asset');
  const artifactURL = signatureClassification === 'unsigned' && tarAsset.uuid && /^[0-9a-f-]{36}$/i.test(tarAsset.uuid)
    ? new URL(`/attachments/${tarAsset.uuid}`, resolvedRepo.source.base_url).toString()
    : selected.url;

  let trust: ReturnType<typeof releaseArtifactTrust> | undefined;
  if (signatureClassification === 'complete') {
    try {
      trust = releaseArtifactTrust(selected.url);
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
    try { await verifySignedReleaseArtifactBuffer(selected.url, bytes, 'standalone.tar', expectedDigest); }
    catch (cause) { throw new MarketNativeArtifactPolicyError('Native app signature or checksum verification failed', { cause }); }
    signature = { status: `verified-${trust!.class}`, keyId: `youeye-${trust!.class}-v1` };
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
      const staged = await stageMarketNativeArtifact(directory, container, marketSource, options.releases?.[container.name]);
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
