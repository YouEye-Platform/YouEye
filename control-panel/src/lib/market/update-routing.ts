import { compareLines, compareReleases, isNewer, releaseLine, type ReleaseKey } from '@/lib/version';
import { normalizeMarketAddress } from './market-format';
import type { CatalogEntry } from './types';

export interface InstalledUpdateEvidence {
  type?: 'native' | 'basic' | 'market' | null;
  catalogKey?: string | null;
  sourceId?: string | null;
  sourceRepoUrl?: string | null;
  installedBranch?: string | null;
  channelSource?: string | null;
}

export interface InstallMetadataUpdateEvidence {
  catalogKey?: string | null;
  itemKind?: string | null;
  sourceId?: string | null;
  sourceRepoUrl?: string | null;
  manifestPath?: string | null;
  manifestRepo?: string | null;
  integration?: 'native' | 'basic' | null;
}

export interface ResolvedCatalogUpdateEvidence {
  sourceId: string;
  entry: Pick<CatalogEntry, 'path' | 'integration'>;
  manifestIntegration: 'native' | 'basic';
}

/**
 * `channel`: a native app; its candidate is its product release on the box's
 * channel index. `catalog`: a catalog app; its candidate is the catalog manifest.
 */
export interface UpdateRoutingDecision {
  kind: 'catalog' | 'channel';
  reason: 'native-app' | 'recorded-external-catalog' | 'default-catalog';
  /** Exact Market source retained for external catalog lookup and audit metadata. */
  catalogSourceId?: string;
}

export interface UpdateCandidate {
  /** Release name (display). */
  version: string;
  tag: string;
  /** Line and sequence of a channel release; channel candidates are ordered by it. */
  key?: ReleaseKey;
  /** SHA-256 of the release's app package (`standalone.tar`): the build, whatever release names it. */
  artifactSHA256?: string;
}

export interface UpdateAvailability {
  catalogVersion: string | null;
  updateAvailable: boolean;
  switchPending: boolean;
  candidateVersion: string | null;
  candidateBranch: string | null;
  candidateTag: string | null;
}

export interface CatalogUpdateState {
  installedVersion: string;
  catalogVersion: string;
  installedTag: null;
  installedBranch: null;
  channelSource: null;
  candidateVersion: null;
  candidateBranch: null;
  candidateTag: null;
  updateAvailable: false;
  switchPending: false;
}

function clean(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

/** A market address in its one written form (HTTPS folder URL with the trailing slash), or undefined when it is none. */
function marketAddress(value: string | null | undefined): string | undefined {
  const raw = clean(value);
  if (!raw) return undefined;
  try { return normalizeMarketAddress(raw); } catch { return undefined; }
}

/** True when both are the same market address. An address that is no market address (a repository URL) matches nothing. */
export function sameMarketAddress(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  const normalizedLeft = marketAddress(left);
  return !!normalizedLeft && normalizedLeft === marketAddress(right);
}

/**
 * Why an installed app may not take updates from the source its id now resolves to, or null when it may: the app
 * recorded another market address (`sourceRepoUrl`) than the source has now. A source's address can be edited, and an
 * id may have been handed out again; an app follows the address it was installed from (or explicitly switched to,
 * `PATCH /api/market/app/<id>/source`), never just the id. The official Market's address follows the box's channel
 * and is not recorded, so it is never "changed".
 */
export function recordedSourceAddressChange(
  recorded: { sourceRepoUrl?: string | null },
  source: { kind: string; name: string; url: string },
): { recordedAddress: string; message: string } | null {
  if (source.kind !== 'url') return null;
  const recordedAddress = clean(recorded.sourceRepoUrl);
  if (!recordedAddress || sameMarketAddress(recordedAddress, source.url)) return null;
  return {
    recordedAddress,
    message: `This app was installed from ${recordedAddress}; the Market source "${source.name}" now points at ${source.url}. `
      + 'Switch the app to that source on its page if you want its updates from there.',
  };
}

function catalogKeySourceId(catalogKey: string | null | undefined): string | undefined {
  const value = clean(catalogKey);
  if (!value) return undefined;
  const separator = value.indexOf(':');
  return separator > 0 ? value.slice(0, separator) : undefined;
}

/** Ordered, de-duplicated Market source identities from install.json and installed-apps state. */
export function recordedCatalogSourceIds(
  installed: InstalledUpdateEvidence,
  installMetadata: InstallMetadataUpdateEvidence,
): string[] {
  const values = [
    clean(installMetadata.sourceId),
    clean(installed.sourceId),
    catalogKeySourceId(installMetadata.catalogKey),
    catalogKeySourceId(installed.catalogKey),
  ];
  return values.filter((value, index): value is string => !!value && values.indexOf(value) === index);
}

export function hasRecordedCatalogIdentity(
  installed: InstalledUpdateEvidence,
  installMetadata: InstallMetadataUpdateEvidence,
): boolean {
  return recordedCatalogSourceIds(installed, installMetadata).length > 0
    || !!clean(installMetadata.manifestPath)
    || !!clean(installMetadata.manifestRepo)
    || installMetadata.itemKind === 'app';
}

/** Decide the update source before release resolution or runtime mutation. */
export function classifyAppUpdateRouting(input: {
  appId: string;
  installed: InstalledUpdateEvidence;
  installMetadata: InstallMetadataUpdateEvidence;
  catalog?: ResolvedCatalogUpdateEvidence | null;
}): UpdateRoutingDecision {
  const { installed, installMetadata, catalog } = input;
  const native = catalog?.entry.integration === 'native'
    || catalog?.manifestIntegration === 'native'
    || installMetadata.integration === 'native'
    || installed.type === 'native';
  if (native) return { kind: 'channel', reason: 'native-app', catalogSourceId: catalog?.sourceId };
  if (catalog || hasRecordedCatalogIdentity(installed, installMetadata)) {
    return {
      kind: 'catalog',
      reason: 'recorded-external-catalog',
      catalogSourceId: catalog?.sourceId || recordedCatalogSourceIds(installed, installMetadata)[0],
    };
  }
  return { kind: 'catalog', reason: 'default-catalog' };
}

/** True when every installed app package is the candidate's package: the same build. False when either is unknown. */
export function sameBuild(installed: readonly string[] | null | undefined, candidate: string | null | undefined): boolean {
  return !!candidate && !!installed?.length && installed.every((sha256) => sha256 === candidate);
}

/** What a box knows of a native app's installed build. */
export interface InstalledNativeBuild {
  /** Line and sequence of the installed release: its recorded release, else its product floor (the last accepted). */
  key?: ReleaseKey | null;
  /** SHA-256 of each installed app package (install.json `nativeArtifacts`). */
  artifactSHA256?: readonly string[] | null;
  /** The installed release name (its line is read from it). */
  version?: string | null;
  /** When the install record was created (ISO time): the installed build was published before it. */
  installedAt?: string | null;
}

/**
 * Order of a native app's channel release against the build it runs: 1 newer, 0 the same build, -1 older, null when
 * this box can't tell (then it is neither offered nor applied: a box never downgrades an app, YE-141).
 *
 * With a release key (recorded, or the product floor) the key decides. Without one (installed or restored before
 * 0.6.15), the build decides as far as the box can see it:
 * - the same package (`standalone.tar`) is the same build (YE-139);
 * - another line is older or newer by its line, as the key would order it;
 * - in the same line, a release whose `sequence` (its publish time) is after the install record was created is
 *   newer: the installed build was published before it was installed (or restored). Anything else can't be ordered,
 *   and the app waits for a build published after it was installed, or for the next line.
 */
export function compareToInstalledNative(
  installed: InstalledNativeBuild,
  candidate: { key: ReleaseKey; artifactSHA256?: string | null },
): number | null {
  if (installed.key) return compareReleases(candidate.key, installed.key);
  if (sameBuild(installed.artifactSHA256, candidate.artifactSHA256)) return 0;
  const line = installed.version ? releaseLine(installed.version) : null;
  if (!line) return null;
  const order = compareLines(candidate.key.line, line);
  if (order !== 0) return order;
  const installedAt = installed.installedAt ? Date.parse(installed.installedAt) / 1000 : NaN;
  return Number.isFinite(installedAt) && candidate.key.sequence > installedAt ? 1 : null;
}

/**
 * Whether a native app's channel release is the build it runs (YE-139): the same line and sequence as its recorded
 * release, or, without one, the same package. The update then has nothing to do and the installed name stays.
 */
export function isInstalledNativeBuild(installed: InstalledNativeBuild, candidate: { key: ReleaseKey; artifactSHA256?: string | null }): boolean {
  return compareToInstalledNative(installed, candidate) === 0;
}

/**
 * Shared update projection used by Settings, Market, the UI bridge and the
 * CLI (`youeye app check-updates`, `info`). A native app's channel candidate is
 * ordered by line and sequence, never by release name: an older release is
 * never offered (the box waits for its channel to catch up), and the same build
 * under another release name (the box changed channel, or the build was
 * promoted) is no update either: the app keeps showing the release it
 * installed until a newer build arrives, which brings its own name (owner,
 * 2026-11-23, YE-139).
 */
export function projectUpdateAvailability(input: {
  routing: UpdateRoutingDecision;
  installedVersion: string | null | undefined;
  /** Line and sequence of the installed native release, when known. */
  installedKey?: ReleaseKey | null;
  /** SHA-256 of each installed app package (install.json `nativeArtifacts`), for an install without a recorded release. */
  installedArtifactSHA256?: readonly string[] | null;
  /** When the install record was created, for an install without a recorded release (see compareToInstalledNative). */
  installedAt?: string | null;
  catalogVersion: string | null;
  candidate?: UpdateCandidate | null;
}): UpdateAvailability {
  const installedVersion = clean(input.installedVersion);
  const candidate = input.routing.kind === 'channel' ? input.candidate ?? null : null;
  const version = candidate ? candidate.version : input.routing.kind === 'catalog' ? input.catalogVersion : null;
  let updateAvailable = false;
  if (version) {
    try {
      if (!candidate) {
        updateAvailable = !installedVersion || isNewer(version, installedVersion);
      } else if (candidate.key) {
        // Only a newer build is an update: not the same build under another name (YE-139), not an older one, and not
        // one this box can't order against an install without a recorded release (YE-141).
        updateAvailable = compareToInstalledNative({
          key: input.installedKey, artifactSHA256: input.installedArtifactSHA256, version: installedVersion,
          installedAt: input.installedAt,
        }, { key: candidate.key, artifactSHA256: candidate.artifactSHA256 }) === 1;
      }
    } catch {
      updateAvailable = false;
    }
  }
  return {
    catalogVersion: version ?? input.catalogVersion,
    updateAvailable,
    switchPending: false,
    candidateVersion: version ?? input.catalogVersion,
    candidateBranch: null,
    candidateTag: candidate?.tag ?? null,
  };
}

/** Successful external updates erase only synthetic native-channel provenance. */
export function catalogUpdateState(version: string): CatalogUpdateState {
  return {
    installedVersion: version,
    catalogVersion: version,
    installedTag: null,
    installedBranch: null,
    channelSource: null,
    candidateVersion: null,
    candidateBranch: null,
    candidateTag: null,
    updateAvailable: false,
    switchPending: false,
  };
}
