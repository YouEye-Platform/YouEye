import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { promisify } from 'node:util';

import { downloadProductAsset, downloadProductAssetTo, downloadReleaseFileTo, resolveChannelProduct } from '@/lib/releases/channel-index';
import { productReceipt, verifyInstalledProductReceipt, type InstalledProductReceipt, type VerifiedProductRelease } from '@/lib/releases/product-release';
import { MAX_NATIVE_PACKAGE_BYTES } from './app-format/schema';
import type { AppManifest, InstallConfig, InstallMetadata, NativePackageSpec } from './types';

const execFileAsync = promisify(execFile);
/** Largest native app package (standalone.tar), the manifest's `source.package.size` limit. It is streamed to disk
 * and to the container, never held in memory, so this bounds disk use and time only. */
export const MAX_ARTIFACT_BYTES = MAX_NATIVE_PACKAGE_BYTES;
const MAX_ARCHIVE_ENTRIES = 100_000;
const MAX_ARCHIVE_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * What binds a staged package. A native Market app (0.6.20, YE-142): `manifest`, its manifest's `source.package`
 * (SHA-256 and size). Pointer, and native apps installed before 0.6.20: `product-release`, the digests of a product
 * release document from the box's channel index.
 */
export type MarketNativeVerification = { status: 'product-release'; releaseSHA256: string } | { status: 'manifest' };

export interface StagedMarketNativeArtifact {
  containerName: string;
  path: string;
  /** The release tag (Pointer); for a Market app, its version. */
  tag: string;
  version: string;
  /** Where the package came from: Pointer's release repository; a Market app's package URL. */
  sourceRepo: string;
  artifactName: 'standalone.tar';
  artifactSHA256: string;
  artifactBytes: number;
  verification: MarketNativeVerification;
  /** Pointer only: the product release receipt (a Market app has none). */
  productRelease?: InstalledProductReceipt;
  runtimeUUID?: string;
}

export interface StagedMarketNativeArtifacts {
  byContainerName: Map<string, StagedMarketNativeArtifact>;
  cleanup(): Promise<void>;
}

export interface MarketNativeStageOptions {
  skipContainerNames?: string[];
  /** Tests: the download (the release-download rules: HTTPS only, redirects checked, 403/429 back-off). */
  download?: typeof downloadReleaseFileTo;
}

export class MarketNativeArtifactPolicyError extends Error {
  override name = 'MarketNativeArtifactPolicyError';
}

/** Pointer, the System's own native product: its product release from the box's channel index. */
export async function resolveNativeProduct(product: string): Promise<VerifiedProductRelease> {
  const selected = await resolveChannelProduct(product);
  if (!selected) throw new MarketNativeArtifactPolicyError(`This channel has no ${product} release yet`);
  if (selected.build.kind !== 'native') throw new MarketNativeArtifactPolicyError(`${product} release is not a native app`);
  return selected;
}

/** The package a native app's manifest names (`source.package`), or null (a frozen copy from before 0.6.20). */
export function nativePackageOf(manifest: Pick<AppManifest, 'containers'>): NativePackageSpec | null {
  const lxd = manifest.containers.filter((container) => container.type === 'lxd');
  return lxd.length === 1 ? lxd[0].source?.package ?? null : null;
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

/** Digest-bound native archive staging of a product release: managed Pointer. */
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
 * Stage a native Market app's package (`source.package`) into `directory`: download it from its URL by the
 * release-download rules, then check its size and SHA-256 against the manifest and that the archive is a safe app
 * tree with a `server.js`. Nothing else is trusted: any market, official or custom, may name any HTTPS host.
 */
export async function stageMarketPackage(
  directory: string,
  containerName: string,
  pkg: NativePackageSpec,
  version: string,
  download: typeof downloadReleaseFileTo = downloadReleaseFileTo,
): Promise<StagedMarketNativeArtifact> {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(containerName)) throw new MarketNativeArtifactPolicyError('Invalid native app staging identity');
  if (!Number.isSafeInteger(pkg.size) || pkg.size <= 0 || pkg.size > MAX_ARTIFACT_BYTES || !/^[0-9a-f]{64}$/.test(pkg.sha256)) {
    throw new MarketNativeArtifactPolicyError('The app package is not pinned by size and SHA-256');
  }
  const artifactPath = join(directory, `${containerName}.standalone.tar`);
  let written: { bytes: number; sha256: string };
  try {
    written = await download(pkg.url, artifactPath, pkg.size);
  } catch (error) {
    throw new MarketNativeArtifactPolicyError(`The app package could not be downloaded from ${pkg.url}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (written.bytes !== pkg.size || written.sha256 !== pkg.sha256) {
    throw new MarketNativeArtifactPolicyError(`The app package from ${pkg.url} is not the one the manifest names (size or SHA-256 differs)`);
  }
  await inspectMarketNativeArchive(artifactPath, 'server.js');
  return {
    containerName, path: artifactPath, tag: version, version, sourceRepo: pkg.url, artifactName: 'standalone.tar',
    artifactSHA256: written.sha256, artifactBytes: written.bytes, verification: { status: 'manifest' },
  };
}

/**
 * Stage the package of a native app (its single LXD container) from the manifest's `source.package`. A manifest
 * without one (a frozen copy from before 0.6.20) cannot be installed again from it: the app is reinstalled or updated
 * from its market, which names the package.
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
  if (manifest.metadata.id !== config.appId) throw new MarketNativeArtifactPolicyError('The manifest belongs to another app');
  const container = nativeContainers[0];
  const pkg = container.source?.package;
  if (!pkg) {
    throw new MarketNativeArtifactPolicyError(`${config.appId} ${manifest.version} names no package (source.package); `
      + 'update YouEye\'s Market first, then try again');
  }
  const directory = await mkdtemp(join(tmpdir(), 'youeye-market-native-'));
  try {
    byContainerName.set(container.name, await stageMarketPackage(directory, container.name, pkg, manifest.version, options.download));
    return {
      byContainerName,
      cleanup: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * The package records of the native runtimes a restore (or a retained-data adoption) brings back instead of installing
 * them, taken from the earlier install record: the app keeps the package it runs, so it is not offered that same
 * package as an update. Two kinds are kept for this app, its manifest version and a recovered container:
 * - `manifest` (a native Market app, 0.6.20 on): its package SHA-256 and size, as recorded;
 * - `product-release` (installed from the channel before 0.6.20): only when its release receipt still verifies; the
 *   digest and size come from the receipt. Such a record moves to its market at the next update check (YE-142).
 * Anything else is dropped. `runtimeUUID` is left out: the recovered instance is a new runtime.
 */
export function recoveredNativeArtifacts(
  appId: string,
  version: string | undefined,
  recorded: unknown,
  recoveredContainerNames: string[],
): NonNullable<InstallMetadata['nativeArtifacts']> {
  if (!Array.isArray(recorded) || !version) return [];
  const artifacts: NonNullable<InstallMetadata['nativeArtifacts']> = [];
  for (const entry of recorded as Array<Partial<NonNullable<InstallMetadata['nativeArtifacts']>[number]>>) {
    if (!entry || typeof entry !== 'object' || typeof entry.containerName !== 'string'
      || !recoveredContainerNames.includes(entry.containerName)
      || artifacts.some((artifact) => artifact.containerName === entry.containerName)) continue;
    if (entry.verification === 'manifest' && !entry.productRelease) {
      if (entry.version !== version || entry.artifactName !== 'standalone.tar' || typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sha256)
        || !Number.isSafeInteger(entry.bytes) || (entry.bytes as number) <= 0 || (entry.bytes as number) > MAX_ARTIFACT_BYTES
        || typeof entry.sourceRepo !== 'string' || typeof entry.releaseTag !== 'string') continue;
      artifacts.push({ containerName: entry.containerName, sourceRepo: entry.sourceRepo, releaseTag: entry.releaseTag, version,
        artifactName: 'standalone.tar', sha256: entry.sha256, bytes: entry.bytes as number, verification: 'manifest' });
      continue;
    }
    if (!entry.productRelease) continue;
    let selected: VerifiedProductRelease;
    try { selected = verifyInstalledProductReceipt(entry.productRelease, { product: appId }); } catch { continue; }
    const primary = selected.build.kind === 'native' ? selected.build.assets.find((asset) => asset.name === 'standalone.tar') : undefined;
    if (!primary || selected.release.version !== version) continue;
    artifacts.push({
      productRelease: productReceipt(selected),
      containerName: entry.containerName,
      sourceRepo: selected.repository,
      releaseTag: selected.release.tag,
      version: selected.release.version,
      artifactName: 'standalone.tar',
      sha256: primary.sha256,
      bytes: primary.size_bytes,
      verification: 'product-release',
      productReleaseSHA256: selected.manifestSHA256,
    });
  }
  return artifacts;
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
