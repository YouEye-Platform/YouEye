import { isNewer } from '@/lib/version';
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

export interface UpdateRoutingDecision {
  kind: 'catalog' | 'channel';
  reason:
    | 'explicit-channel-override'
    | 'explicit-channel-source'
    | 'native-repo-catalog-entry'
    | 'recorded-external-catalog'
    | 'legacy-release-source'
    | 'default-catalog';
  /** App release repository used as the base when channel config only changes the branch. */
  channelDefaultSource?: string;
  /** Exact Market source retained for external catalog lookup and audit metadata. */
  catalogSourceId?: string;
}

export interface UpdateCandidate {
  version: string;
  branch: string;
  tag: string;
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

/** Resolve an `owner/repo` catalog entry against the Market source's forge. */
export function catalogRepoReferenceToUrl(
  repo: string | null | undefined,
  catalogSourceRepoUrl: string | null | undefined,
): string | undefined {
  const reference = clean(repo);
  if (!reference) return undefined;
  if (reference.includes('://')) return normalizeRepositoryUrl(reference);

  const sourceUrl = clean(catalogSourceRepoUrl);
  if (sourceUrl) {
    try {
      const parsed = new URL(sourceUrl);
      return `${parsed.protocol}//${parsed.host}/${reference.replace(/^\/+/, '').replace(/\.git$/i, '')}`;
    } catch {
      // Fall through to the platform forge used by legacy catalog entries.
    }
  }
  return undefined;
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

/**
 * Decide the update source before release resolution or runtime mutation.
 * `installedBranch` is deliberately absent from the decision: older external
 * catalog updates wrote a synthetic `main` branch and must remain catalog-routed.
 */
export function classifyAppUpdateRouting(input: {
  appId: string;
  installed: InstalledUpdateEvidence;
  installMetadata: InstallMetadataUpdateEvidence;
  catalog?: ResolvedCatalogUpdateEvidence | null;
  hasExplicitChannelOverride: boolean;
}): UpdateRoutingDecision {
  const { installed, installMetadata, catalog } = input;
  const catalogSourceUrl = catalog?.sourceRepoUrl;
  const catalogSourceUrls = [catalogSourceUrl, ...(catalog?.sourceRepoUrls ?? [])];
  const isCatalogSource = (value: string | null | undefined) => (
    catalogSourceUrls.some((sourceUrl) => repositoriesMatch(value, sourceUrl))
  );
  const channelSource = clean(installed.channelSource);
  const nonCatalogChannelSource = channelSource && !isCatalogSource(channelSource)
    ? channelSource
    : undefined;
  const installedRepoSource = clean(installed.sourceRepoUrl);
  const nonCatalogInstalledRepo = installedRepoSource && !isCatalogSource(installedRepoSource)
    ? installedRepoSource
    : undefined;
  const entryRepoSource = catalogRepoReferenceToUrl(catalog?.entry.repo, catalogSourceUrl);

  if (input.hasExplicitChannelOverride) {
    return {
      kind: 'channel',
      reason: 'explicit-channel-override',
      channelDefaultSource: nonCatalogChannelSource || entryRepoSource || nonCatalogInstalledRepo,
      catalogSourceId: catalog?.sourceId,
    };
  }

  if (nonCatalogChannelSource) {
    return {
      kind: 'channel',
      reason: 'explicit-channel-source',
      channelDefaultSource: nonCatalogChannelSource,
      catalogSourceId: catalog?.sourceId,
    };
  }

  if (nonCatalogInstalledRepo) {
    return {
      kind: 'channel',
      reason: 'legacy-release-source',
      channelDefaultSource: nonCatalogInstalledRepo,
      catalogSourceId: catalog?.sourceId,
    };
  }

  const isNativeRepoEntry = !!catalog?.entry.repo
    && (catalog.entry.integration === 'native'
      || catalog.manifestIntegration === 'native'
      || installMetadata.integration === 'native'
      || installed.type === 'native');
  if (isNativeRepoEntry) {
    return {
      kind: 'channel',
      reason: 'native-repo-catalog-entry',
      channelDefaultSource: entryRepoSource || nonCatalogInstalledRepo,
      catalogSourceId: catalog?.sourceId,
    };
  }

  const isExternalCatalogEntry = !!catalog && (
    !!catalog.entry.path
    || !!catalog.entry.file
    || catalog.entry.integration === 'basic'
    || catalog.manifestIntegration === 'basic'
  );
  if (isExternalCatalogEntry || hasRecordedCatalogIdentity(installed, installMetadata)) {
    return {
      kind: 'catalog',
      reason: 'recorded-external-catalog',
      catalogSourceId: catalog?.sourceId || recordedCatalogSourceIds(installed, installMetadata)[0],
    };
  }

  return {
    kind: 'catalog',
    reason: 'default-catalog',
    catalogSourceId: catalog?.sourceId,
  };
}

export function isChannelSwitchConfirmationRequired(input: {
  force: boolean;
  confirmSwitch: boolean;
  installedBranch: string;
  candidateBranch: string;
  candidateIsNewer: boolean;
}): boolean {
  return !input.force
    && !input.confirmSwitch
    && input.candidateBranch !== input.installedBranch
    && !input.candidateIsNewer;
}

/** Shared update-vs-switch projection used by Settings, Market, and UI bridge data. */
export function projectUpdateAvailability(input: {
  routing: UpdateRoutingDecision;
  installedVersion: string | null | undefined;
  installedBranch: string | null | undefined;
  catalogVersion: string | null;
  candidate?: UpdateCandidate | null;
}): UpdateAvailability {
  const installedVersion = clean(input.installedVersion);

  if (input.routing.kind === 'catalog') {
    let updateAvailable = false;
    if (input.catalogVersion) {
      if (!installedVersion) {
        updateAvailable = true;
      } else {
        try {
          updateAvailable = isNewer(input.catalogVersion, installedVersion);
        } catch {
          updateAvailable = false;
        }
      }
    }
    return {
      catalogVersion: input.catalogVersion,
      updateAvailable,
      switchPending: false,
      candidateVersion: input.catalogVersion,
      candidateBranch: null,
      candidateTag: null,
    };
  }

  const candidate = input.candidate ?? null;
  if (!candidate) {
    return {
      catalogVersion: input.catalogVersion,
      updateAvailable: false,
      switchPending: false,
      candidateVersion: input.catalogVersion,
      candidateBranch: null,
      candidateTag: null,
    };
  }

  let candidateIsNewer = !installedVersion;
  if (installedVersion) {
    try {
      candidateIsNewer = isNewer(candidate.version, installedVersion);
    } catch {
      candidateIsNewer = false;
    }
  }
  const installedBranch = clean(input.installedBranch) || 'main';
  return {
    catalogVersion: candidate.version,
    updateAvailable: candidateIsNewer,
    switchPending: !candidateIsNewer && candidate.branch !== installedBranch,
    candidateVersion: candidate.version,
    candidateBranch: candidate.branch,
    candidateTag: candidate.tag,
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
