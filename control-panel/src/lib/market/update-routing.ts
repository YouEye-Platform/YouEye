import { compareVersions, isNewer } from '@/lib/version';
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
  sourceRepoUrl: string;
  sourceRepoUrls?: string[];
  entry: Pick<CatalogEntry, 'repo' | 'path' | 'file' | 'integration'>;
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
  /** Build version of the release; channel candidates are ordered by it. */
  build?: string;
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

/** Compare repository identities without treating `.git` or a trailing slash as meaningful. */
export function normalizeRepositoryUrl(value: string | null | undefined): string | undefined {
  const raw = clean(value);
  if (!raw) return undefined;

  try {
    const parsed = new URL(raw);
    parsed.username = '';
    parsed.password = '';
    parsed.hash = '';
    parsed.search = '';
    const pathname = parsed.pathname.replace(/\/+$/, '').replace(/\.git$/i, '');
    return `${parsed.protocol.toLowerCase()}//${parsed.host.toLowerCase()}${pathname}`;
  } catch {
    return raw.replace(/\/+$/, '').replace(/\.git$/i, '').toLowerCase();
  }
}

export function repositoriesMatch(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  const normalizedLeft = normalizeRepositoryUrl(left);
  const normalizedRight = normalizeRepositoryUrl(right);
  return !!normalizedLeft && normalizedLeft === normalizedRight;
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

/**
 * Shared update projection used by Settings, Market, and UI bridge data. A
 * native app's channel candidate is ordered by build, never by release name:
 * an older build is never offered (the box waits for its channel to catch
 * up); the same build under another release name is a metadata-only update.
 */
export function projectUpdateAvailability(input: {
  routing: UpdateRoutingDecision;
  installedVersion: string | null | undefined;
  /** Build version of the installed native release, when known. */
  installedBuild?: string | null;
  catalogVersion: string | null;
  candidate?: UpdateCandidate | null;
}): UpdateAvailability {
  const installedVersion = clean(input.installedVersion);
  const installedBuild = clean(input.installedBuild);
  const candidate = input.routing.kind === 'channel' ? input.candidate ?? null : null;
  const version = candidate ? candidate.version : input.routing.kind === 'catalog' ? input.catalogVersion : null;
  let updateAvailable = false;
  if (version) {
    try {
      if (!candidate) {
        updateAvailable = !installedVersion || isNewer(version, installedVersion);
      } else if (!installedBuild) {
        // Not installed from a product release (no recorded build): offer the channel's release.
        updateAvailable = true;
      } else if (candidate.build) {
        const order = compareVersions(candidate.build, installedBuild);
        updateAvailable = order > 0 || order === 0 && version !== installedVersion;
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
