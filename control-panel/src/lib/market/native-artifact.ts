import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { isDeepStrictEqual, promisify } from 'node:util';

import { downloadProductAsset, downloadProductAssetTo, resolveChannelProduct } from '@/lib/releases/channel-index';
import { productReceipt, type InstalledProductReceipt, type VerifiedProductRelease } from '@/lib/releases/product-release';
import type { AppManifest, InstallConfig } from './types';

const execFileAsync = promisify(execFile);
/** Largest native app package (standalone.tar). It is streamed to disk and to
 * the container, never held in memory, so this bounds disk use and time only. */
export const MAX_ARTIFACT_BYTES = 1024 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 100_000;
const MAX_ARCHIVE_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 2 * 1024 * 1024 * 1024;

/** Native archives are always bound by their product release digests. */
export type MarketNativeVerification = { status: 'product-release'; releaseSHA256: string };

export interface StagedMarketNativeArtifact {
  containerName: string;
  path: string;
  tag: string;
  version: string;
  sourceRepo: string;
  artifactName: 'standalone.tar';
  artifactSHA256: string;
  artifactBytes: number;
  verification: MarketNativeVerification;
  productRelease: InstalledProductReceipt;
  runtimeUUID?: string;
}

export interface StagedMarketNativeArtifacts {
  byContainerName: Map<string, StagedMarketNativeArtifact>;
  cleanup(): Promise<void>;
}

export interface MarketNativeStageOptions {
  /** The exact release an update already selected; otherwise the channel index is read. */
  selected?: VerifiedProductRelease;
  skipContainerNames?: string[];
}

export class MarketNativeArtifactPolicyError extends Error {
  override name = 'MarketNativeArtifactPolicyError';
}

/** The native app of the box's channel: its product release from the channel index. */
export async function resolveNativeProduct(product: string): Promise<VerifiedProductRelease> {
  const selected = await resolveChannelProduct(product);
  if (!selected) throw new MarketNativeArtifactPolicyError(`This channel has no ${product} release yet`);
  if (selected.build.kind !== 'native') throw new MarketNativeArtifactPolicyError(`${product} release is not a native app`);
  return selected;
}

/**
 * The installer contract (`youeye-app.yaml`) of a native product release, as the Market
 * presents it: digest-checked against the build, parsed strictly, and versioned by the release.
 * Native releases carry no setup files and no listing images (relative files have no host).
 */
export async function nativeManifestFromContract(contract: Buffer, selected: VerifiedProductRelease): Promise<AppManifest> {
  if (createHash('sha256').update(contract).digest('hex') !== selected.build.contract_sha256) {
    throw new MarketNativeArtifactPolicyError('Product installer contract digest differs');
  }
  const { loadApp } = await import('./app-format/compile');
  let manifest: AppManifest;
  try {
    manifest = loadApp({ manifest: contract.toString('utf8') });
  } catch (error) {
    throw new MarketNativeArtifactPolicyError(`Product installer contract is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (manifest.metadata.id !== selected.release.product || manifest.integration !== 'native') {
    throw new MarketNativeArtifactPolicyError('Product installer contract names another app');
  }
  manifest.version = selected.release.version;
  if (manifest.frozen) manifest.frozen.version = selected.release.version;
  manifest.metadata.iconUrl = undefined;
  if (manifest.detail) manifest.detail.screenshots = [];
  return manifest;
}

export async function nativeManifestFromRelease(selected: VerifiedProductRelease): Promise<{ manifest: AppManifest; contract: Buffer }> {
  const contract = await downloadProductAsset(selected, 'youeye-app.yaml');
  return { manifest: await nativeManifestFromContract(contract, selected), contract };
}

/**
 * The install record's manifest reference for a native release. Its digest is the manifest's
 * canonical frozen digest, the same value an install records, so the frozen copy keeps matching.
 */
export function nativeManifestReference(selected: Pick<VerifiedProductRelease, 'repository' | 'release'>, manifest: AppManifest) {
  if (!manifest.frozen?.digest) throw new MarketNativeArtifactPolicyError('Product installer contract has no frozen digest');
  return { path: 'youeye-app.yaml', repo: selected.repository, branch: selected.release.tag, digest: manifest.frozen.digest };
}

/** The manifest an install or update uses must be exactly the release's contract. */
export async function verifyMarketProductInstallContract(contract: Buffer, selected: VerifiedProductRelease, manifest: AppManifest): Promise<void> {
  if (!isDeepStrictEqual(await nativeManifestFromContract(contract, selected), manifest)) {
    throw new MarketNativeArtifactPolicyError('Selected application manifest differs from the product contract');
  }
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

/** Shared digest-bound native archive staging for Market apps and managed Pointer. */
export async function stageVerifiedProductArtifact(directory: string, containerName: string, assembly: VerifiedProductRelease, expectedDigest?: string): Promise<StagedMarketNativeArtifact> {
  if (assembly.build.kind !== 'native' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(containerName)) throw new MarketNativeArtifactPolicyError('Invalid native product staging identity');
  if (assembly.release.product === 'pointer') {
    const contract = await downloadProductAsset(assembly, 'pointer-build-contract.json');
    if (createHash('sha256').update(contract).digest('hex') !== assembly.build.contract_sha256) throw new MarketNativeArtifactPolicyError('Pointer build contract differs');
  }
  const primary = assembly.build.assets.find(a => a.name === 'standalone.tar');
  if (!primary) throw new MarketNativeArtifactPolicyError('Native product release has no standalone.tar');
  if (expectedDigest && expectedDigest !== primary.sha256) throw new MarketNativeArtifactPolicyError('Native app artifact does not match the manifest SHA-256');
  if (primary.size_bytes > MAX_ARTIFACT_BYTES) {
    const mb = (bytes: number) => Math.ceil(bytes / (1024 * 1024));
    throw new MarketNativeArtifactPolicyError(`The ${assembly.release.product} ${assembly.release.version} package (${mb(primary.size_bytes)} MB) is larger than the limit (${mb(MAX_ARTIFACT_BYTES)} MB)`);
  }
  const artifactPath = join(directory,`${containerName}.standalone.tar`);
  const artifactBytes = await downloadProductAssetTo(assembly, 'standalone.tar', artifactPath, MAX_ARTIFACT_BYTES);
  await inspectMarketNativeArchive(artifactPath,'server.js');
  return {containerName,path:artifactPath,tag:assembly.release.tag,version:assembly.release.version,
    sourceRepo:assembly.repository,artifactName:'standalone.tar',artifactSHA256:primary.sha256,
    artifactBytes,verification:{status:'product-release',releaseSHA256:assembly.manifestSHA256},productRelease:productReceipt(assembly)};
}

/**
 * Stage the native archive of an app. A native app is one product: its single
 * LXD container runs that product's `standalone.tar`, found through the box's
 * channel index (or the exact release an update already selected).
 */
export async function stageMarketNativeArtifacts(
  manifest: AppManifest,
  config: Pick<InstallConfig, 'appId'>,
  options: MarketNativeStageOptions = {},
): Promise<StagedMarketNativeArtifacts> {
  const skipped = new Set(options.skipContainerNames ?? []);
  const lxd = manifest.containers.filter((container) => container.type === 'lxd');
  const nativeContainers = lxd.filter((container) => !skipped.has(container.name));
  const byContainerName = new Map<string, StagedMarketNativeArtifact>();
  if (nativeContainers.length === 0) return { byContainerName, cleanup: async () => undefined };
  if (lxd.length !== 1) throw new MarketNativeArtifactPolicyError('A native app has exactly one LXD container');
  const product = config.appId;
  const selected = options.selected ?? await resolveNativeProduct(product);
  if (selected.release.product !== product) throw new MarketNativeArtifactPolicyError('Selected release belongs to another app');

  const directory = await mkdtemp(join(tmpdir(), 'youeye-market-native-'));
  try {
    const container = nativeContainers[0];
    const staged = await stageVerifiedProductArtifact(directory, container.name, selected, container.source?.artifactSHA256?.toLowerCase());
    byContainerName.set(container.name, staged);
    return {
      byContainerName,
      cleanup: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/** Re-check a staged archive's size and digest (streamed) right before it is deployed. */
export async function verifyStagedMarketNativeArtifact(artifact: StagedMarketNativeArtifact): Promise<void> {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(artifact.path)) {
    bytes += (chunk as Buffer).byteLength;
    hash.update(chunk as Buffer);
  }
  if (hash.digest('hex') !== artifact.artifactSHA256 || bytes !== artifact.artifactBytes) {
    throw new Error('Staged native app artifact changed before deployment');
  }
}
