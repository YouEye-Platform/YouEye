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
 * Where an app's update comes from: its market (`catalog`). Since 0.6.20 every app, native or container, updates from
 * the market it was installed from (YE-142); a native app no longer has a `channel` route. `integration: 'native'`
 * says what the app can do (widgets, the gateway token, admission, copy), never where it comes from.
 */
export interface UpdateRoutingDecision {
  kind: 'catalog';
  reason: 'recorded-external-catalog' | 'default-catalog';
  /** Exact Market source retained for external catalog lookup and audit metadata. */
  catalogSourceId?: string;
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
 * `PATCH /api/market/app/<id>/source`), never just the id. The official Market's address is the box's own lane
 * setting and is not recorded, so it is never "changed".
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

/** Decide the update source before any manifest resolution or runtime mutation: the app's market. */
export function classifyAppUpdateRouting(input: {
  appId: string;
  installed: InstalledUpdateEvidence;
  installMetadata: InstallMetadataUpdateEvidence;
  catalog?: ResolvedCatalogUpdateEvidence | null;
}): UpdateRoutingDecision {
  const { installed, installMetadata, catalog } = input;
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

/** What a box knows of a channel product's installed build (Pointer). */
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
 * Order of a channel release (Pointer, the System's native product) against the build it runs: 1 newer, 0 the same build, -1 older, null when
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
 * Shared update projection used by Settings, Market, the UI bridge and the CLI (`youeye app check-updates`, `info`):
 * the market's version is an update when it is newer than the installed one (`isNewer`: an older version is never
 * offered), except for the same package (`source.package.sha256` equal to every installed `standalone.tar`; YE-139's
 * rule, by package; YE-142): then the manifest decides, whatever the version names. The same manifest (the record's
 * `manifestDigest` equal to the market's frozen digest) is no update; another one is (YE-194: the update check takes it
 * itself when only the record changes, `adoptNativeMarketManifest`, so what stays offered is a new configuration of
 * the same package, applied by the ordinary update), unless it names a lower version than a Market record (YE-212).
 * A container app has no package and is decided by version alone.
 */
export function projectUpdateAvailability(input: {
  routing: UpdateRoutingDecision;
  installedVersion: string | null | undefined;
  /** SHA-256 of each installed app package (install.json `nativeArtifacts`). */
  installedArtifactSHA256?: readonly string[] | null;
  catalogVersion: string | null;
  /** SHA-256 of the package the market's manifest pins (a native app). */
  candidateArtifactSHA256?: string | null;
  /** The installed native app's manifest digest (install.json `manifestDigest`) and the market's (its frozen digest). */
  installedManifestDigest?: string | null;
  candidateManifestDigest?: string | null;
  /** The installed native app's record names a market manifest (not a channel release, YE-142): its version is the
   * market's own name, so a lower one is not offered for the same package either (YE-212). */
  marketRecord?: boolean;
}): UpdateAvailability {
  const installedVersion = clean(input.installedVersion);
  const version = input.catalogVersion;
  let updateAvailable = false;
  if (version) {
    try {
      updateAvailable = sameBuild(input.installedArtifactSHA256, input.candidateArtifactSHA256)
        ? !!input.installedManifestDigest && !!input.candidateManifestDigest && input.installedManifestDigest !== input.candidateManifestDigest
          && !(input.marketRecord && installedVersion && isNewer(installedVersion, version))
        : !installedVersion || isNewer(version, installedVersion);
    } catch {
      updateAvailable = false;
    }
  }
  return {
    catalogVersion: version,
    updateAvailable,
    switchPending: false,
    candidateVersion: version,
    candidateBranch: null,
    candidateTag: null,
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
