/**
 * The Market as the rest of the Control Panel reads it: apps, categories, curation and bundles of the box's markets.
 *
 * Every market, the official one included, is a folder of static files at an HTTPS address (`youeye.market.v1`,
 * market-format.ts). The box keeps an accepted copy of each (market-store.ts); this module reads that copy and
 * never the network itself. The store refreshes a market at most every five minutes in the background; a reader
 * waits only when the store is still empty or right after `clearCatalogCache()` (an explicit "check for updates"),
 * and then 20 seconds at most (`MARKET_READER_WAIT_MS`): a market that is slow to answer delays no listing longer.
 *
 * - A container app is an index entry plus its bundle: the text of `youeye-app.yaml` and of its setup files, parsed
 *   strictly with the one app-format parser, and the hashed paths of its pictures.
 * - A native app is an id in the `native` list of the OFFICIAL Market's index; its manifest is the one of its release
 *   on the box's channel (native-artifact.ts). Native apps are YouEye's own: the `native` list of any other market
 *   is ignored (`nativeIdsOf`), so a custom market neither lists nor installs them.
 * - An entry this box cannot use (its `requires.youeye` is above the box, or its kind is unknown) is listed as
 *   "needs a newer YouEye" from the index alone; its bundle is never parsed, and installing it is refused.
 * - A market never supplies the core containers (Caddy, PostgreSQL, Pi-hole): their images are pinned in
 *   lib/infrastructure/system-images.
 */

import { loadApp } from './app-format/compile';
import { parseBundle } from './app-format/parse';
import { youeyeRequirementProblem } from './app-format/requires';
import { describeReleaseError } from '../releases/channel-index';
import { isKnownAppKind, requiredYouEye, type MarketAppBundle, type MarketIndexEntry } from './market-format';
import { currentMarket, requestMarketRefresh, type AcceptedMarket } from './market-store';
import { nativeListing } from './native-artifact';
import { releaseKey, type ReleaseKey } from '../version';
import { loadCatalogEntries, type CatalogWarning } from './partial-catalog';
import type { AppManifest, Catalog, CatalogEntry, MarketApp, MarketBundle, MarketCategory, MarketCuration } from './types';
import {
  getConfiguredMarketSources, getMarketSources, isOfficialMarketSource, marketSourceRefusal, officialMarketSource,
  OFFICIAL_MARKET_SOURCE_ID, usableMarketSource, type MarketSource,
} from './source';

/** The address of a market picture on this box (`/api/market/image` serves only paths an accepted market names). */
export const marketImageURL = (sourceId: string, file: string) =>
  `/api/market/image?source=${encodeURIComponent(sourceId)}&file=${encodeURIComponent(file)}`;

/**
 * Where an app's manifest came from, as an install records it (`manifestPath`, `manifestRepo`, `manifestBranch`,
 * `manifestDigest`).
 */
export interface ManifestReference {
  /** `apps/<id>/youeye-app.yaml` for a market app; `youeye-app.yaml` for a native release. */
  path: string;
  /** A market app: the market's address. A native app: its release repository. */
  repo: string;
  /** A market app: the commit of the market it was read at. A native app: its release tag. */
  branch: string;
  /** The manifest's frozen digest (app-format/digest.ts): the same for the same manifest and setup files, whatever carried them. */
  digest: string;
  /** Native channel products only: the release's line and sequence (orders updates). */
  key?: ReleaseKey;
}

export interface ManifestFetchResult {
  manifest: AppManifest;
  reference: ManifestReference;
}

export interface ResolvedCatalogApp extends ManifestFetchResult {
  source: MarketSource;
  entry: CatalogEntry;
}

/**
 * This box cannot use the app: it needs a newer YouEye (`requires.youeye` above the box, or a kind this YouEye does
 * not know). The message is safe to show.
 */
export class MarketAppUnavailableError extends Error {
  readonly code = 'requires-newer-youeye' as const;
  constructor(
    message: string,
    /** The YouEye version the app needs (X.Y.Z), when the market states one above the box. */
    readonly needsYouEye?: string,
    /** The version the market offers. */
    readonly version?: string,
  ) {
    super(message);
    this.name = 'MarketAppUnavailableError';
  }
}

export function isMarketAppUnavailable(error: unknown): error is MarketAppUnavailableError {
  return error instanceof Error && error.name === 'MarketAppUnavailableError';
}

/** The official source as configured (it may be turned off), or its defaults. Never a custom market. */
async function officialSource(): Promise<MarketSource> {
  return (await getConfiguredMarketSources()).find(isOfficialMarketSource) ?? officialMarketSource();
}

/** The version of YouEye on this box; null when Spine cannot say (then nothing is held back for its requirement here). */
async function boxVersion(): Promise<string | null> {
  try {
    const { getPlatformContext } = await import('./platform-env');
    const version = (await getPlatformContext()).version;
    return version && version !== '0.0.0' ? version : null;
  } catch {
    return null;
  }
}

// ─── Catalog ──────────────────────────────────────────────

/**
 * The native app ids a source lists: the official Market's `native` list, and nothing for any other source. A native
 * app is installed from the box's channel index, never from a market, so only YouEye's own market may offer one.
 */
function nativeIdsOf(source: Pick<MarketSource, 'kind'>, accepted: AcceptedMarket): readonly string[] {
  return isOfficialMarketSource(source) ? accepted.index.native : [];
}

function catalogOf(source: Pick<MarketSource, 'kind'>, accepted: AcceptedMarket): Catalog {
  const apps: CatalogEntry[] = accepted.index.apps.map((entry) => ({ id: entry.id, integration: 'basic', path: `apps/${entry.id}` }));
  for (const id of nativeIdsOf(source, accepted)) {
    // A container app wins over a native id of the same name; the listing says so (`fetchAvailableApps`).
    if (!apps.some((app) => app.id === id)) apps.push({ id, integration: 'native' });
  }
  const curation = accepted.index.curation;
  return {
    apps: apps.sort((a, b) => a.id.localeCompare(b.id)),
    bundles: accepted.index.bundles.map((bundle) => bundle.id),
    categories: accepted.index.categories.map((category) => ({ ...category })),
    curation: curation ? {
      spotlight: curation.spotlight ? { title: curation.spotlight.title, apps: [...curation.spotlight.apps] } : undefined,
      collections: (curation.collections ?? []).map((collection) => ({ ...collection, apps: [...collection.apps] })),
    } : undefined,
  };
}

/** The catalog of a source (the official Market when none is given), from its store. */
export async function fetchCatalog(marketSource?: MarketSource): Promise<Catalog> {
  const source = marketSource ?? await officialSource();
  return catalogOf(source, await currentMarket(source));
}

// ─── Manifests ────────────────────────────────────────────

/** Why this box cannot use an index entry, or null when it can. */
function entryBlock(entry: MarketIndexEntry, version: string | null): MarketAppUnavailableError | null {
  const problem = version ? youeyeRequirementProblem(entry.requires, version) : null;
  if (!isKnownAppKind(entry.kind)) {
    return new MarketAppUnavailableError(problem ?? `${entry.name} needs a newer YouEye than this box runs.`,
      problem ? requiredYouEye(entry) ?? undefined : undefined, entry.version);
  }
  return problem ? new MarketAppUnavailableError(problem, requiredYouEye(entry) ?? undefined, entry.version) : null;
}

/**
 * Point the listing icon and screenshots at this box's image route. A manifest names its pictures by their file
 * names in the app folder; the bundle's `files` map gives each its hashed path in the market.
 */
function resolveManifestPaths(manifest: AppManifest, source: MarketSource, files: MarketAppBundle['files']): void {
  const address = (name: string | undefined) => {
    const hashed = name ? files?.[name] : undefined;
    return hashed ? marketImageURL(source.id, hashed) : undefined;
  };
  manifest.metadata.iconUrl = address(manifest.metadata.iconUrl);
  if (manifest.detail) {
    manifest.detail.screenshots = manifest.detail.screenshots.flatMap((screenshot) => {
      const url = address(screenshot.path);
      return url ? [{ ...screenshot, path: url }] : [];
    });
  }
}

/** Compiled manifests by source, address, entry id and bundle hash (parsing 35 manifests on every listing call is not free). */
const MANIFESTS = Symbol.for('youeye.market-compiled-manifests');
const manifestHolder = globalThis as typeof globalThis & { [MANIFESTS]?: Map<string, AppManifest> };
const compiledManifests = manifestHolder[MANIFESTS] ??= new Map();
const MAX_COMPILED_MANIFESTS = 2000;

/** The app of an index entry, from its stored bundle, parsed strictly. Throws `MarketAppUnavailableError` for an entry this box cannot use. */
function manifestOfEntry(accepted: AcceptedMarket, source: MarketSource, entry: MarketIndexEntry, version: string | null): ManifestFetchResult {
  const blocked = entryBlock(entry, version);
  if (blocked) throw blocked;
  if (!entry.bundle) throw new Error('the market lists no bundle for it');
  const stored = accepted.bundles.get(entry.id);
  if (!stored) throw new Error('its bundle is missing from this box\'s copy of the market');
  if (!stored.ok) throw new Error(stored.reason);
  // The same bundle bytes under two entries are two compilations: what is kept belongs to one entry id.
  const key = `${source.id}\0${accepted.address}\0${entry.id}\0${entry.bundle.sha256}`;
  let manifest = compiledManifests.get(key);
  if (!manifest) {
    // Bundles name setup files by their file name; the parser knows them as `setup/<file name>`. Every file is
    // passed, so a file the app does not name is refused.
    const setups = Object.fromEntries(Object.entries(stored.bundle.setups ?? {}).map(([name, text]) => [`setup/${name}`, text]));
    manifest = loadApp({ manifest: stored.bundle.manifest, setups });
    resolveManifestPaths(manifest, source, stored.bundle.files);
    if (compiledManifests.size >= MAX_COMPILED_MANIFESTS) compiledManifests.clear();
    compiledManifests.set(key, manifest);
  }
  // Checked for every answer, kept or just compiled: an entry never resolves to the manifest of another app.
  if (manifest.metadata.id !== entry.id) throw new Error(`its bundle holds app "${manifest.metadata.id}"`);
  return {
    manifest: structuredClone(manifest),
    reference: {
      path: `apps/${entry.id}/youeye-app.yaml`,
      repo: accepted.address,
      branch: accepted.pointer.commit ?? '',
      digest: manifest.frozen!.digest,
    },
  };
}

/** A native app: its release on the box's channel (kept by the digest of its channel index entry). */
async function nativeManifest(id: string): Promise<ManifestFetchResult> {
  const { selected, manifest } = await nativeListing(id);
  return {
    manifest,
    reference: { path: 'youeye-app.yaml', repo: selected.repository, branch: selected.release.tag, digest: manifest.frozen!.digest, key: releaseKey(selected.release) },
  };
}

async function manifestOfApp(accepted: AcceptedMarket, source: MarketSource, appId: string): Promise<(ManifestFetchResult & { entry: CatalogEntry }) | null> {
  const entry = accepted.index.apps.find((candidate) => candidate.id === appId);
  if (entry) return { ...manifestOfEntry(accepted, source, entry, await boxVersion()), entry: { id: appId, integration: 'basic', path: `apps/${appId}` } };
  if (nativeIdsOf(source, accepted).includes(appId)) return { ...await nativeManifest(appId), entry: { id: appId, integration: 'native' } };
  return null;
}

/** An app by id from the official Market (for display; installs and updates use `resolveCatalogApp`). */
export async function fetchManifest(appId: string): Promise<AppManifest> {
  const source = await officialSource();
  const found = await manifestOfApp(await currentMarket(source), source, appId);
  if (!found) throw new Error(`App "${appId}" not found in catalog`);
  return found.manifest;
}

/**
 * An app's manifest from one named Market source (the official Market when none is named). Used when the same app
 * id exists in several sources and the reader must follow the one the user chose.
 */
export async function fetchManifestFromSource(appId: string, sourceId?: string): Promise<AppManifest> {
  if (!sourceId) return fetchManifest(appId);
  const source = (await getMarketSources()).find((candidate) => candidate.id === sourceId);
  if (!source) throw new Error(`Market source "${sourceId}" not found`);
  const found = await manifestOfApp(await currentMarket(source), source, appId);
  if (!found) throw new Error(`App "${appId}" not found in Market source "${sourceId}"`);
  return found.manifest;
}

/**
 * Resolve an app for an install or update from exactly one Market source: the one named (an install's choice, or
 * the source recorded for an installed app), else the official Market. Never another source, and never one the owner
 * has not accepted (`marketSourceRefusal`; the error is a `MarketSourceConsentError`). An app this box cannot use is
 * refused with `MarketAppUnavailableError`.
 */
export async function resolveCatalogApp(appId: string, sourceId?: string | null): Promise<ResolvedCatalogApp> {
  const source = await usableMarketSource(sourceId);
  const fail = (reason: string) => new Error(`App "${appId}" could not be resolved from Market source "${source.id}" (${reason})`);

  let accepted: AcceptedMarket;
  try {
    accepted = await currentMarket(source);
  } catch (error) {
    throw fail(`catalog could not be loaded: ${error instanceof Error ? error.message : String(error)}`);
  }
  let found: Awaited<ReturnType<typeof manifestOfApp>>;
  try {
    found = await manifestOfApp(accepted, source, appId);
  } catch (error) {
    if (isMarketAppUnavailable(error)) throw error;
    throw fail(`app manifest could not be loaded: ${describeReleaseError(error)}`);
  }
  if (!found) throw fail('app is not present');
  return { source, ...found };
}

// ─── MarketApp Conversion ─────────────────────────────────

/** The install-time "YouEye ID sign-in" toggle of an app whose SSO needs a setup file. */
function getDisplayIntegrations(manifest: AppManifest): NonNullable<MarketApp['integrations']> {
  if (!manifest.sso || !manifest.setups.some((setup) => setup.for === 'sso')) return [];
  return [{
    id: 'youeye-id',
    name: 'Identity Sign-In',
    description: 'Configure this app to use the identity provider after the base app is installed.',
    type: 'identity',
    recommended: true,
    installByDefault: true,
    required: false,
    permissions: ['identity:oauth-client:create'],
  }];
}

/** The fields every listed app of a source carries, installable or not. */
function sourceFields(source: MarketSource | undefined, appId: string) {
  return {
    catalogKey: source ? `${source.id}:app:${appId}` : undefined,
    itemKind: 'app' as const,
    sourceId: source?.id,
    sourceName: source?.name,
    sourceRepoUrl: source?.url || undefined,
    // Listed, but refused for install until the owner accepts the source.
    ...(source && marketSourceRefusal(source)?.code === 'source-not-accepted' ? { sourceNotAccepted: true as const } : {}),
  };
}

export function manifestToMarketApp(manifest: AppManifest, source?: MarketSource, reference?: ManifestReference): MarketApp {
  const hasNotificationSurface = manifest.surfaces.some(
    (surface) => surface.kind === 'notification' && surface.placement === 'notification-center'
  );
  const capabilities = manifest.capabilities || hasNotificationSurface ? {
    widgets: manifest.capabilities?.widgets,
    notifications: manifest.capabilities?.notifications || (hasNotificationSurface ? true : undefined),
    smtp: manifest.capabilities?.smtp,
    ai_api: manifest.capabilities?.ai_api,
    link_handlers: manifest.capabilities?.link_handlers,
  } : undefined;

  return {
    id: manifest.metadata.id,
    ...sourceFields(source, manifest.metadata.id),
    manifestPath: reference?.path,
    manifestRepo: reference?.repo,
    manifestBranch: reference?.branch,
    manifestDigest: reference?.digest,
    name: manifest.metadata.name,
    description: manifest.metadata.description,
    icon: manifest.metadata.icon,
    iconUrl: manifest.metadata.iconUrl,
    category: manifest.metadata.category,
    integration: manifest.integration,
    version: manifest.version,
    requiresYouEye: manifest.requires?.youeye,
    defaultSubdomain: manifest.metadata.defaultSubdomain,
    supportsSSO: !!manifest.sso,
    website: manifest.metadata.website,
    developer: manifest.metadata.developer,
    license: manifest.metadata.license,
    sourceCode: manifest.metadata.sourceCode,
    support: manifest.metadata.support,
    docs: manifest.metadata.docs,
    tagline: manifest.metadata.tagline,
    tags: manifest.metadata.tags,
    detail: manifest.detail ? {
      longDescription: manifest.detail.longDescription,
      releaseNotes: manifest.detail.releaseNotes,
      screenshots: manifest.detail.screenshots.map((s) => ({
        url: s.path,
        caption: s.caption,
      })),
    } : undefined,
    setups: manifest.setups.map((setup) => ({ name: setup.name, for: setup.for })),
    integrations: getDisplayIntegrations(manifest),
    forwardAuth: manifest.forwardAuth,
    // Only the official catalog may default an app to public access (added sources are not reviewed).
    publicAccess: source?.id === OFFICIAL_MARKET_SOURCE_ID ? manifest.publicAccess : undefined,
    capabilities,
    surfaces: manifest.surfaces,
  };
}

/** An app this box cannot install, listed from its index entry alone (its bundle is not read). */
function blockedMarketApp(entry: MarketIndexEntry, source: MarketSource, blocked: MarketAppUnavailableError): MarketApp {
  const description = entry.description ?? entry.tagline ?? entry.name;
  return {
    id: entry.id,
    ...sourceFields(source, entry.id),
    name: entry.name,
    description,
    icon: 'package',
    iconUrl: entry.icon ? marketImageURL(source.id, entry.icon) : undefined,
    category: entry.category ?? 'other',
    integration: 'basic',
    version: entry.version,
    requiresYouEye: entry.requires?.youeye,
    defaultSubdomain: entry.id,
    supportsSSO: false,
    developer: entry.developer,
    tagline: entry.tagline,
    tags: entry.tags ?? [],
    installBlocked: { code: blocked.code, message: blocked.message },
    ...(blocked.needsYouEye ? { needsYouEye: blocked.needsYouEye } : {}),
  };
}

// ─── Public API ───────────────────────────────────────────

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Every app of every enabled source. An app this box cannot install is listed with `installBlocked`; an app whose
 * manifest does not load, an index entry that was skipped and a source that cannot be read are reported through
 * `onWarning` with the real reason, and never hide the others.
 */
export async function fetchAvailableApps(onWarning?: (warning: CatalogWarning) => void): Promise<MarketApp[]> {
  const sources = await getMarketSources();
  const version = await boxVersion();

  const results = await Promise.allSettled(sources.map(async (source) => {
    const accepted = await currentMarket(source);
    for (const warning of accepted.index.warnings) onWarning?.({ sourceId: source.id, message: `${source.name}: skipped ${warning}.` });
    const reportFailure = (entry: { id: string }, error: unknown) => {
      console.warn(`[market] ${source.id}/${entry.id}: manifest unavailable`, error);
      onWarning?.({ sourceId: source.id, itemId: entry.id, message: `${source.name}: ${entry.id} could not be loaded: ${describeReleaseError(error)}` });
    };
    const containers = accepted.index.apps.flatMap((entry): MarketApp[] => {
      try {
        const blocked = entryBlock(entry, version);
        if (blocked) return [blockedMarketApp(entry, source, blocked)];
        const result = manifestOfEntry(accepted, source, entry, version);
        return [manifestToMarketApp(result.manifest, source, result.reference)];
      } catch (error) {
        reportFailure(entry, error);
        return [];
      }
    });
    const nativeIds = nativeIdsOf(source, accepted).filter((id) => {
      if (!accepted.index.apps.some((entry) => entry.id === id)) return true;
      onWarning?.({ sourceId: source.id, itemId: id, message: `${source.name}: ${id} is listed as a native app and as a container app; the container app is shown.` });
      return false;
    });
    const natives = await loadCatalogEntries(nativeIds.map((id) => ({ id })), async (entry) => {
      const result = await nativeManifest(entry.id);
      return manifestToMarketApp(result.manifest, source, result.reference);
    }, reportFailure);
    return [...containers, ...natives].sort((a, b) => a.id.localeCompare(b.id));
  }));

  const apps: MarketApp[] = [];
  for (const [index, result] of results.entries()) {
    if (result.status === 'fulfilled') {
      apps.push(...result.value);
    } else {
      const source = sources[index];
      console.warn(`[market] ${source.id}: catalog unavailable`, result.reason);
      onWarning?.({ sourceId: source.id, message: `${source.name}: could not load its catalog: ${reason(result.reason)}` });
    }
  }
  return apps;
}

/** The accepted markets of the enabled sources, in priority order; a source that cannot be read is left out. */
async function enabledMarkets(sources?: MarketSource[]): Promise<Array<{ source: MarketSource; accepted: AcceptedMarket }>> {
  const list = sources ?? await getMarketSources();
  const results = await Promise.allSettled(list.map((source) => currentMarket(source)));
  return results.flatMap((result, index) => (result.status === 'fulfilled' ? [{ source: list[index], accepted: result.value }] : []));
}

/**
 * Market category metadata (pills, labels, icons, ordering, fallback tiles) of the enabled sources. Categories are
 * merged by id across sources in priority order (the first source to declare a category id wins) and returned
 * sorted by `order`.
 */
export async function fetchCategories(): Promise<MarketCategory[]> {
  const byId = new Map<string, MarketCategory>();
  for (const { accepted } of await enabledMarkets()) {
    for (const category of accepted.index.categories) {
      if (!byId.has(category.id)) byId.set(category.id, { ...category });
    }
  }
  return [...byId.values()].sort(
    (a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER),
  );
}

/**
 * The Market curation (spotlight strip + collections) for the Market home. The first enabled source (priority
 * order) that declares a `curation` section wins.
 */
export async function fetchCuration(): Promise<MarketCuration | null> {
  for (const { source, accepted } of await enabledMarkets()) {
    const curation = catalogOf(source, accepted).curation;
    if (curation) return curation;
  }
  return null;
}

/** The bundle definitions of one source's market. A bundle that fails to load is logged and skipped. */
function bundlesOf(source: MarketSource, accepted: AcceptedMarket): MarketBundle[] {
  const out: MarketBundle[] = [];
  for (const { id, definition } of accepted.index.bundles) {
    try {
      const bundle = parseBundle(definition);
      if (bundle.id !== id) throw new Error(`holds bundle "${bundle.id}"`);
      out.push({
        id: bundle.id,
        name: bundle.name,
        description: bundle.description,
        icon: bundle.icon,
        category: bundle.category,
        setupSummary: bundle.summary,
        members: [...bundle.members],
        connections: (bundle.connections ?? []).map((connection) => ({ ...connection, scope: connection.scope ?? 'service' })),
        storageGroups: [...(bundle.shared ?? [])],
        sourceId: source.id,
        sourceName: source.name,
        ...(marketSourceRefusal(source)?.code === 'source-not-accepted' ? { sourceNotAccepted: true as const } : {}),
      });
    } catch (err) {
      console.error(`[catalog] Failed to load bundle "${id}" of ${source.id}:`, err);
    }
  }
  return out;
}

/**
 * The bundle definitions across enabled Market sources, deduped by id with the official Market first, then source
 * priority. Each bundle names its source: its members install from it.
 */
export async function fetchBundles(): Promise<MarketBundle[]> {
  const sources = [...await getMarketSources()].sort((a, b) => Number(!isOfficialMarketSource(a)) - Number(!isOfficialMarketSource(b)));
  const out: MarketBundle[] = [];
  const seen = new Set<string>();
  for (const { source, accepted } of await enabledMarkets(sources)) {
    for (const bundle of bundlesOf(source, accepted)) {
      if (seen.has(bundle.id)) continue;
      seen.add(bundle.id);
      out.push(bundle);
    }
  }
  return out;
}

/** A bundle definition by id from one enabled source (the official Market when none is named), or null. */
export async function fetchBundle(id: string, sourceId?: string | null): Promise<MarketBundle | null> {
  const wanted = sourceId?.trim() || OFFICIAL_MARKET_SOURCE_ID;
  const source = (await getMarketSources()).find((candidate) => candidate.id === wanted);
  if (!source) return null;
  const [market] = await enabledMarkets([source]);
  return market ? bundlesOf(source, market.accepted).find((bundle) => bundle.id === id) ?? null : null;
}

/**
 * An explicit "check for updates" (and what follows a change of the source list): the next read of the source (of
 * every source when none is named) asks its market again and waits for the answer. Without it, readers use the
 * store and markets are asked in the background, at most every five minutes each.
 */
export function clearCatalogCache(sourceId?: string | null): void {
  requestMarketRefresh(sourceId);
}
