import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import { randomBytes } from 'crypto';
import path from 'path';
import { normalizeMarketAddress } from './market-format';
import { sameMarketAddress } from './update-routing';
import { isPrivateHostname } from './url-app';

/** Where the Market keeps its files. Tests point it at a temporary directory. */
export function marketStateDir(): string {
  return process.env.YOUEYE_MARKET_STATE_DIR || '/var/lib/youeye';
}
const sourcesPath = () => path.join(marketStateDir(), 'market-sources.json');

/**
 * Market sources.
 *
 * A market is a folder of static files at an HTTPS address (`youeye.market.v1`, market-format.ts).
 *
 * - The official Market (`kind: 'official'`) always exists and can only be turned off. Its address is not stored: it is
 *   its lane's (`officialMarketAddress`): `main` unless the owner chose `dev` (`lane` on its entry; YE-142, 0.6.20).
 *   Before 0.6.20 the lane followed the box's release channel.
 * - Custom markets (`kind: 'url'`) are addresses the owner added. Their ids are the box's (`custom-N`); a market never
 *   names its own id.
 *
 * What a market holds, when it was last refreshed and why a refresh failed are in the market's store
 * (market-store.ts), not in this list.
 */
export interface MarketSource {
  id: string;
  name: string;
  kind: 'official' | 'url';
  /** Market address of a custom market (normalised, with the trailing slash); empty for the official Market. */
  url: string;
  enabled: boolean;
  priority: number;
  /** The official Market only: the lane the box reads (`main` when not set, the default for every box). */
  lane?: OfficialMarketLane;
  /**
   * When the owner accepted this custom market (ISO time). Set only by the Control Panel: when the market is added
   * with `acceptRisk: true`, or by `POST /api/market/source/accept`. Without it, the market's apps are listed but
   * never installed, updated or switched to (`marketSourceRefusal`). The official Market needs none.
   */
  accepted_at?: string;
}

interface StoredMarketSource {
  id?: string;
  /** The official entry only: `main` or `dev`. Another value (a later reader's lane) reads as `main`. */
  lane?: string;
  name?: string;
  url?: string;
  /** Written before 0.6.11 by sources that were git repositories; such an entry is removed when it is read. */
  repo_url?: string;
  branch?: string;
  enabled?: boolean;
  priority?: number;
  accepted_at?: string;
}

/** A source this box had before 0.6.11 (a git repository read as raw files) that the Market can no longer read. */
export interface RemovedMarketSource {
  id: string;
  name: string;
  /** The repository address it had. */
  address: string;
  branch?: string;
  removed_at: string;
}

interface StoredSourceList {
  active_sources?: StoredMarketSource[];
  removed_sources?: RemovedMarketSource[];
}

export const OFFICIAL_MARKET_SOURCE_ID = 'official';
export const OFFICIAL_MARKET_NAME = 'Official YouEye Market';

/**
 * The official Market's two lanes. Every box reads `main` unless its owner chose `dev` (`youeye market official-lane
 * dev`, Settings → Market); the lane no longer follows the release channel (owner, 2026-11-23, YE-142).
 */
export const OFFICIAL_MARKET_ADDRESSES = {
  main: 'https://market.youeye.me/',
  dev: 'https://market.youeye.me/dev/',
} as const;
export type OfficialMarketLane = keyof typeof OFFICIAL_MARKET_ADDRESSES;
export const OFFICIAL_MARKET_LANES = Object.keys(OFFICIAL_MARKET_ADDRESSES) as OfficialMarketLane[];
export const isOfficialMarketLaneName = (value: unknown): value is OfficialMarketLane =>
  typeof value === 'string' && (OFFICIAL_MARKET_LANES as string[]).includes(value);

export function isOfficialMarketAddress(address: string | null | undefined): boolean {
  return address === OFFICIAL_MARKET_ADDRESSES.main || address === OFFICIAL_MARKET_ADDRESSES.dev;
}

/** The answer when an official lane is offered as a custom market (adding it, re-pointing a market at it, a preview of the other lane). */
export const OFFICIAL_MARKET_AS_CUSTOM = 'This is the official YouEye Market; your YouEye already follows it';

/**
 * True for the address of an official lane, however its host is spelled (a trailing dot names the same server).
 * A custom market is never one of these: the box already follows its official lane, and the other lane would
 * list every app twice. Other folders of the same host (`https://market.youeye.me/test/…`) are ordinary markets.
 */
export function isOfficialMarketLane(address: string | null | undefined): boolean {
  if (!address) return false;
  try {
    const url = new URL(address);
    return isOfficialMarketAddress(`${url.protocol}//${url.host.toLowerCase().replace(/\.(?=$|:)/, '')}${url.pathname}`);
  } catch {
    return false;
  }
}

/**
 * The official Market's address now: its lane's (`lane` on the official entry of market-sources.json), `main` when
 * none is set. Nothing is asked of Spine: the lane is the box's own setting, not its release channel (YE-142).
 */
export function officialMarketAddress(source?: Pick<MarketSource, 'lane'> | null): { address: string; lane: OfficialMarketLane; from: 'setting' | 'default' } {
  const lane = source?.lane;
  return isOfficialMarketLaneName(lane)
    ? { address: OFFICIAL_MARKET_ADDRESSES[lane], lane, from: 'setting' }
    : { address: OFFICIAL_MARKET_ADDRESSES.main, lane: 'main', from: 'default' };
}

export function officialMarketSource(options: { enabled?: boolean; lane?: OfficialMarketLane } = {}): MarketSource {
  return { id: OFFICIAL_MARKET_SOURCE_ID, name: OFFICIAL_MARKET_NAME, kind: 'official', url: '', enabled: options.enabled ?? true, priority: 0,
    ...(options.lane ? { lane: options.lane } : {}) };
}

export const isOfficialMarketSource = (source: Pick<MarketSource, 'kind'>) => source.kind === 'official';

const MARKET_SOURCE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** Ids no custom market may take: the official Market's, and `direct` (the source id prefix of apps added by URL). */
const RESERVED_MARKET_SOURCE_IDS = new Set([OFFICIAL_MARKET_SOURCE_ID, 'direct']);

/** A custom market from its address. Throws when the address cannot be a market address. */
export function customMarketSource(
  url: string,
  options: { id: string; name?: string; enabled?: boolean; priority?: number; accepted_at?: string },
): MarketSource {
  const address = normalizeMarketAddress(url);
  return {
    id: options.id,
    name: options.name?.trim() || new URL(address).host,
    kind: 'url',
    url: address,
    enabled: options.enabled ?? true,
    priority: options.priority ?? 1,
    accepted_at: options.accepted_at,
  };
}

async function atomicWriteJSON(filePath: string, value: unknown): Promise<void> {
  // Unique per write: two writers in the same millisecond (two bundled copies of this module) never share a temp file.
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}-${randomBytes(6).toString('hex')}`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, filePath);
}

function stored(source: MarketSource): StoredMarketSource {
  return isOfficialMarketSource(source)
    ? { id: source.id, enabled: source.enabled, ...(source.lane ? { lane: source.lane } : {}) }
    : { id: source.id, name: source.name, url: source.url, enabled: source.enabled, priority: source.priority, accepted_at: source.accepted_at };
}

interface SourceListState {
  sources: MarketSource[];
  removed: RemovedMarketSource[];
  /** The file still holds entries this reader drops (git sources from before 0.6.11): it must be rewritten. */
  stale: boolean;
}

/**
 * The source list from its stored entries. An entry that is not a market address is dropped: a git source from before
 * 0.6.11 (`repo_url`) is remembered in `removed`, so the sources page can say what went away.
 */
function marketSourcesFromStored(raw: StoredSourceList | null | undefined, now = new Date().toISOString()): SourceListState {
  const entries = Array.isArray(raw?.active_sources) ? raw!.active_sources!.filter((entry) => entry && typeof entry === 'object') : [];
  const removed = (Array.isArray(raw?.removed_sources) ? raw!.removed_sources! : [])
    .filter((entry) => entry && typeof entry.id === 'string' && typeof entry.address === 'string');
  const officialEntry = entries.find((entry) => entry.id === OFFICIAL_MARKET_SOURCE_ID);
  const custom: MarketSource[] = [];
  let stale = false;
  for (const [index, entry] of entries.entries()) {
    if (entry === officialEntry) continue;
    const id = typeof entry.id === 'string' ? entry.id : '';
    try {
      if (typeof entry.url !== 'string' || !MARKET_SOURCE_ID_PATTERN.test(id) || RESERVED_MARKET_SOURCE_IDS.has(id)
        || custom.some((source) => source.id === id)) throw new Error('not a market entry');
      custom.push(customMarketSource(entry.url, {
        id,
        name: typeof entry.name === 'string' ? entry.name : undefined,
        enabled: entry.enabled !== false,
        priority: Math.max(1, Number.isFinite(Number(entry.priority)) ? Number(entry.priority) : index + 1),
        accepted_at: typeof entry.accepted_at === 'string' && entry.accepted_at ? entry.accepted_at : undefined,
      }));
    } catch {
      stale = true;
      const address = typeof entry.repo_url === 'string' ? entry.repo_url : typeof entry.url === 'string' ? entry.url : '';
      if (id && address && !removed.some((gone) => gone.id === id && gone.address === address)) {
        removed.push({
          id, name: typeof entry.name === 'string' && entry.name ? entry.name : id, address,
          ...(typeof entry.branch === 'string' && entry.branch ? { branch: entry.branch } : {}), removed_at: now,
        });
      }
    }
  }
  return {
    sources: [officialMarketSource({ enabled: officialEntry?.enabled !== false,
      ...(isOfficialMarketLaneName(officialEntry?.lane) ? { lane: officialEntry!.lane as OfficialMarketLane } : {}) }), ...custom]
      .sort((a, b) => a.priority - b.priority),
    removed,
    stale,
  };
}

async function readSourceList(): Promise<SourceListState> {
  let text: string;
  try { text = await readFile(sourcesPath(), 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { sources: [officialMarketSource()], removed: [], stale: false };
    throw error;
  }
  return marketSourcesFromStored(JSON.parse(text) as StoredSourceList);
}

/**
 * The one write chain of the source list in this process. The module is bundled more than once (the API routes and
 * `instrumentation`'s background jobs each get a copy), so the chain lives on `globalThis`: a module-level chain per
 * copy would let one copy write a list read before the other's add or edit, and revert it.
 */
const WRITE_CHAIN = Symbol.for('youeye.market-sources.write-chain');
const writeChainHolder = globalThis as typeof globalThis & { [WRITE_CHAIN]?: { tail: Promise<unknown> } };
const writeChain = writeChainHolder[WRITE_CHAIN] ??= { tail: Promise.resolve() };

/**
 * Read, change and write the source list as one step (one writer at a time in this process). The file is read inside
 * the serialised section. `change` returns null when nothing changes: then nothing is written, unless the file still
 * holds entries the reader dropped.
 */
async function mutateMarketSources(
  change: (sources: MarketSource[], removed: RemovedMarketSource[]) => { sources?: MarketSource[]; removed?: RemovedMarketSource[] } | null,
): Promise<SourceListState> {
  const run = writeChain.tail.catch(() => undefined).then(async () => {
    const current = await readSourceList();
    const changed = change(current.sources, current.removed);
    if (!changed && !current.stale) return current;
    const next: SourceListState = { sources: changed?.sources ?? current.sources, removed: changed?.removed ?? current.removed, stale: false };
    await mkdir(marketStateDir(), { recursive: true });
    await atomicWriteJSON(sourcesPath(), {
      active_sources: next.sources.map(stored),
      ...(next.removed.length ? { removed_sources: next.removed } : {}),
    } satisfies StoredSourceList);
    if (current.stale) console.warn('[market] Sources that are not market addresses were removed from the source list');
    return next;
  });
  writeChain.tail = run;
  return run;
}

/** The list as stored, written back first when it still holds entries this reader drops. */
async function currentSourceList(): Promise<SourceListState> {
  const state = await readSourceList();
  return state.stale ? mutateMarketSources(() => null) : state;
}

/** The official Market plus every custom market, in priority order. */
export async function getConfiguredMarketSources(): Promise<MarketSource[]> {
  return (await currentSourceList()).sources;
}

export async function getMarketSources(): Promise<MarketSource[]> {
  return (await getConfiguredMarketSources()).filter((source) => source.enabled);
}

/** Sources removed when this box moved to markets by address (git sources); shown on the sources page. */
export async function getRemovedMarketSources(): Promise<RemovedMarketSource[]> {
  return (await currentSourceList()).removed;
}

/** The owner has read the note about removed sources. */
export async function dismissRemovedMarketSources(): Promise<void> {
  await mutateMarketSources((_sources, removed) => (removed.length ? { removed: [] } : null));
}

/** One entry of the source list as a client sends it to `PATCH /api/market/source`. */
export interface MarketSourceListEntry {
  id?: unknown;
  name?: unknown;
  url?: unknown;
  enabled?: unknown;
  priority?: unknown;
}

/**
 * The source list after a client's edit: sources can be enabled, disabled, renamed, reordered and removed. A source
 * cannot be created here (`addMarketSource` does that, with consent), and acceptance is never taken from the client.
 * A custom market whose address changes loses its acceptance, and cannot be pointed at an official lane. The official
 * Market is always kept (it may be turned off).
 */
export function applyMarketSourceListEdit(current: MarketSource[], requested: MarketSourceListEntry[]): MarketSource[] {
  const seen = new Set<string>();
  const next: MarketSource[] = [];
  for (const entry of requested) {
    const id = typeof entry?.id === 'string' ? entry.id.trim() : '';
    const existing = current.find((source) => source.id === id);
    if (!existing) throw new Error(`Market source "${id || '(no id)'}" does not exist; add a source with POST /api/market/source`);
    if (seen.has(id)) throw new Error(`Market source "${id}" is listed twice`);
    seen.add(id);
    const enabled = typeof entry.enabled === 'boolean' ? entry.enabled : existing.enabled;
    if (isOfficialMarketSource(existing)) {
      next.push({ ...existing, enabled });
      continue;
    }
    const priority = Number.isFinite(Number(entry.priority)) && entry.priority !== null && entry.priority !== ''
      ? Math.max(1, Number(entry.priority)) : existing.priority;
    const name = typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : existing.name;
    const url = typeof entry.url === 'string' && entry.url.trim() ? checkedMarketAddress(entry.url) : existing.url;
    if (url !== existing.url && isOfficialMarketLane(url)) throw new Error(OFFICIAL_MARKET_AS_CUSTOM);
    next.push(url !== existing.url
      ? { ...existing, url, name, enabled, priority, accepted_at: undefined }
      : { ...existing, name, enabled, priority });
  }
  if (!seen.has(OFFICIAL_MARKET_SOURCE_ID)) next.push(current.find(isOfficialMarketSource) ?? officialMarketSource());
  const addresses = next.filter((source) => !isOfficialMarketSource(source)).map((source) => source.url);
  if (new Set(addresses).size !== addresses.length) throw new Error('Two Market sources have the same address');
  return next.sort((a, b) => a.priority - b.priority);
}

/** Apply a client's edit of the source list (see `applyMarketSourceListEdit`). */
export async function updateMarketSourceList(requested: MarketSourceListEntry[]): Promise<MarketSource[]> {
  return (await mutateMarketSources((current) => ({ sources: applyMarketSourceListEdit(current, requested) }))).sources;
}

/** The official Market's lane as configured (`main` when none is set). */
export async function getOfficialMarketLane(): Promise<OfficialMarketLane> {
  return officialMarketAddress((await getConfiguredMarketSources()).find(isOfficialMarketSource)).lane;
}

/**
 * Set the official Market's lane (`main` or `dev`). The next read of the official Market reads the new lane's address;
 * its store starts a new sequence floor there, and installed apps compare their versions with the new lane's (an app
 * installed from `dev` keeps its version until `main` has a newer one).
 */
export async function setOfficialMarketLane(lane: unknown): Promise<MarketSource> {
  if (!isOfficialMarketLaneName(lane)) throw new Error(`The official Market lane is ${OFFICIAL_MARKET_LANES.join(' or ')}`);
  const { sources } = await mutateMarketSources((current) => ({
    sources: current.map((source) => (isOfficialMarketSource(source) ? { ...source, lane } : source)),
  }));
  return sources.find(isOfficialMarketSource)!;
}

/** A normalised market address that is not an internal host by name (the fetcher checks what it resolves to). */
export function checkedMarketAddress(input: string): string {
  const address = normalizeMarketAddress(input);
  if (isPrivateHostname(new URL(address).hostname)) throw new Error('A market address must point to a public server');
  return address;
}

export interface NewMarketSource {
  /** The market's address (its folder URL, or its market.json). */
  url: string;
  name?: string;
  /** Optional id (lowercase letters, digits, hyphens); generated when omitted. */
  id?: string;
}

/** A source id an installed app still records, with the market address it recorded (empty when none). */
export interface RecordedMarketSourceId {
  sourceId: string;
  sourceRepoUrl?: string | null;
}

/**
 * The source list with a new custom market, accepted at `acceptedAt`. Adding needs the owner's consent first. An
 * official lane is refused (`OFFICIAL_MARKET_AS_CUSTOM`).
 *
 * An installed app follows its source id, so an id an installed app still records (`recorded`) is never handed out
 * again: a generated id skips it, and a chosen one is refused unless it names the same address the app recorded.
 */
export function withAddedMarketSource(
  current: MarketSource[], input: NewMarketSource, acceptedAt: string, recorded: RecordedMarketSourceId[] = [],
): MarketSource[] {
  const address = checkedMarketAddress(input.url);
  if (isOfficialMarketLane(address)) throw new Error(OFFICIAL_MARKET_AS_CUSTOM);
  const requestedId = input.id?.trim();
  if (requestedId !== undefined && requestedId !== '' && (!MARKET_SOURCE_ID_PATTERN.test(requestedId) || RESERVED_MARKET_SOURCE_IDS.has(requestedId))) {
    throw new Error('A Market source id uses lowercase letters, digits and hyphens (at most 32), and is not "official" or "direct"');
  }
  if (requestedId && current.some((source) => source.id === requestedId)) {
    throw new Error(`Market source "${requestedId}" already exists`);
  }
  if (requestedId) {
    const other = recorded.find((entry) => entry.sourceId === requestedId && !sameMarketAddress(entry.sourceRepoUrl, address));
    if (other) {
      throw new Error(`An installed app still records Market source "${requestedId}" for ${other.sourceRepoUrl || 'another address'}; choose another id`);
    }
  }
  if (current.some((existing) => existing.url === address)) throw new Error('This market is already a Market source');
  const taken = (candidate: string) => current.some((source) => source.id === candidate)
    || recorded.some((entry) => entry.sourceId === candidate);
  let id = requestedId;
  for (let n = 1; !id; n++) {
    if (!taken(`custom-${n}`)) id = `custom-${n}`;
  }
  const priority = Math.max(0, ...current.map((source) => source.priority)) + 1;
  return [...current, customMarketSource(address, { id, name: input.name, enabled: true, priority, accepted_at: acceptedAt })];
}

/** Source ids that installed apps record (installed-app store), with their market addresses. */
async function recordedMarketSourceIds(): Promise<RecordedMarketSourceId[]> {
  // Loaded when needed: installed-apps imports the catalog, which imports this module.
  const { getAllInstalledApps } = await import('./installed-apps');
  return (await getAllInstalledApps()).flatMap((app) => {
    const sourceId = app.sourceId || app.catalogKey?.split(':')[0];
    return sourceId ? [{ sourceId, sourceRepoUrl: app.sourceRepoUrl }] : [];
  });
}

/** Add a custom market. The caller has the owner's consent (`acceptRisk`), so the market is accepted now. */
export async function addMarketSource(input: NewMarketSource): Promise<MarketSource> {
  const recorded = await recordedMarketSourceIds();
  const { sources } = await mutateMarketSources((current) => ({ sources: withAddedMarketSource(current, input, new Date().toISOString(), recorded) }));
  return sources[sources.length - 1];
}

/** The owner accepts an existing custom market: its apps may be installed and updated from now on. */
export async function acceptMarketSource(id: string): Promise<MarketSource> {
  let accepted: MarketSource | undefined;
  await mutateMarketSources((current) => ({ sources: current.map((source) => {
    if (source.id !== id) return source;
    if (isOfficialMarketSource(source)) throw new Error('The official Market needs no acceptance');
    accepted = { ...source, accepted_at: source.accepted_at ?? new Date().toISOString() };
    return accepted;
  }) }));
  if (!accepted) throw new Error(`Market source "${id}" does not exist`);
  return accepted;
}

// ─── Consent ─────────────────────────────────────────────

/**
 * Why an app may not be installed, updated or re-pointed from this source; null when it may.
 *
 * The one rule for Market sources: the official Market may always be used; a custom market only after the owner
 * accepted it (`accepted_at`); a disabled or missing source never. Apps added by URL (`direct:` source ids) are not
 * Market sources: each install asks for its own consent (`directAppRefusal`).
 */
export function marketSourceRefusal(source: MarketSource | null | undefined, sourceId?: string): MarketSourceConsentError | null {
  if (!source) return new MarketSourceConsentError('source-unavailable', `Market source "${sourceId ?? ''}" is not configured`);
  if (!source.enabled) return new MarketSourceConsentError('source-unavailable', `Market source "${source.name}" is turned off`);
  if (isOfficialMarketSource(source)) return null;
  if (!source.accepted_at) {
    return new MarketSourceConsentError('source-not-accepted',
      `Market source "${source.name}" is not accepted: its apps are not checked by YouEye. Accept it first `
      + `(youeye market accept ${source.id})`);
  }
  return null;
}

/** The same rule for an app added by URL: the owner trusts its publisher, and allows its setup files when it has any. */
export function directAppRefusal(
  setups: ReadonlyArray<{ name: string; for: string }>,
  consent: { acceptUnverifiedPublisher?: unknown; allowSetup?: unknown },
): MarketSourceConsentError | null {
  if (consent.acceptUnverifiedPublisher !== true) {
    return new MarketSourceConsentError('publisher-not-trusted', 'Confirm that you trust the publisher of this Added app (acceptUnverifiedPublisher)');
  }
  if (setups.length > 0 && consent.allowSetup !== true) {
    return new MarketSourceConsentError('setup-not-allowed',
      'This app runs setup files inside its containers; allow them (allowSetup)', setups.map(({ name, for: purpose }) => ({ name, for: purpose })));
  }
  return null;
}

/** A Market source that may be used for an install or update; the official Market when none is named. */
export async function usableMarketSource(sourceId?: string | null): Promise<MarketSource> {
  const id = sourceId?.trim() || OFFICIAL_MARKET_SOURCE_ID;
  if (id.startsWith('direct:')) throw new MarketSourceConsentError('source-unavailable', 'An Added app is not a Market source');
  const source = (await getConfiguredMarketSources()).find((candidate) => candidate.id === id);
  const refusal = marketSourceRefusal(source, id);
  if (refusal) throw refusal;
  return source!;
}

export type MarketSourceConsentCode = 'source-unavailable' | 'source-not-accepted' | 'publisher-not-trusted' | 'setup-not-allowed'
  | 'setup-changed' | 'source-changed';

/**
 * A refusal for lack of the owner's consent. Its message is safe to show; routes answer 403 (409 for setup-changed).
 * `source-changed`: the app's source id now names another market address than the app was installed from
 * (`recordedSourceAddressChange`); only an explicit switch of the app moves it.
 */
export class MarketSourceConsentError extends Error {
  constructor(
    readonly code: MarketSourceConsentCode,
    message: string,
    readonly setups?: Array<{ name: string; for: string }>,
  ) {
    super(message);
    this.name = 'MarketSourceConsentError';
  }
}

export function isMarketSourceConsentError(error: unknown): error is MarketSourceConsentError {
  return error instanceof Error && error.name === 'MarketSourceConsentError' && typeof (error as { code?: unknown }).code === 'string';
}

/** True when the two apps' setup files differ (names or text). An update that changes them asks again. */
export function setupFilesChanged(
  before: { frozen?: { setups?: Record<string, string> } } | null | undefined,
  after: { frozen?: { setups?: Record<string, string> } } | null | undefined,
): boolean {
  const left = before?.frozen?.setups ?? {};
  const right = after?.frozen?.setups ?? {};
  const names = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const name of names) if (left[name] !== right[name]) return true;
  return false;
}
