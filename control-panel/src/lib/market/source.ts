import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { randomBytes } from 'crypto';
import path from 'path';
import { repositoriesMatch } from './update-routing';

const MARKET_STATE_DIR = '/var/lib/youeye';
const MARKET_SOURCES_PATH = path.join(MARKET_STATE_DIR, 'market-sources.json');

/**
 * Market sources.
 *
 * - The official Market (`kind: 'channel'`) is the `market` product of the
 *   box's channel index: a digest-bound `catalog.tar`. It has no repository,
 *   branch or commit of its own here; it always exists and can only be
 *   disabled.
 * - Custom sources (`kind: 'git'`) are repositories the owner added by URL.
 *   Their catalog and manifests are read as raw files from a branch.
 */
export interface MarketSource {
  id: string;
  name: string;
  kind: 'channel' | 'git';
  /** Repository URL of a custom source; empty for the official channel source. */
  repo_url: string;
  /** Branch of a custom source; empty for the official channel source. */
  branch: string;
  enabled: boolean;
  priority: number;
  trust: 'official' | 'community' | 'custom';
  provider: 'github' | 'gitea' | '';
  base_url: string;
  organization: string;
  repository: string;
  resolved_at?: string;
  refresh_error?: string;
  /**
   * When the owner accepted this custom source (ISO time). Set only by the Control Panel: when the source is added
   * with `acceptRisk: true`, or by `POST /api/market/source/accept`. Without it, the source's apps are listed but
   * never installed, updated or switched to (`marketSourceRefusal`). The official source needs none.
   */
  accepted_at?: string;
}

interface StoredMarketSource {
  id?: string;
  name?: string;
  repo_url?: string;
  branch?: string;
  enabled?: boolean;
  priority?: number;
  trust?: 'official' | 'community' | 'custom';
  resolved_at?: string;
  refresh_error?: string;
  accepted_at?: string;
}

export const OFFICIAL_MARKET_SOURCE_ID = 'official';
export const DEFAULT_MARKET_BRANCH = 'main';
const MARKET_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;

export function officialMarketSource(options: { enabled?: boolean; resolved_at?: string; refresh_error?: string } = {}): MarketSource {
  return {
    id: OFFICIAL_MARKET_SOURCE_ID,
    name: 'Official YouEye Market',
    kind: 'channel',
    repo_url: '',
    branch: '',
    enabled: options.enabled ?? true,
    priority: 0,
    trust: 'official',
    provider: '',
    base_url: '',
    organization: '',
    repository: '',
    resolved_at: options.resolved_at,
    refresh_error: options.refresh_error,
  };
}

export const isChannelMarketSource = (source: Pick<MarketSource, 'kind'>) => source.kind === 'channel';

function detectProvider(baseUrl: string): 'github' | 'gitea' {
  const host = new URL(baseUrl).hostname.toLowerCase();
  return host === 'github.com' || host.endsWith('.github.com') ? 'github' : 'gitea';
}

/** A custom (git) Market source added by URL. */
export function parseMarketRepoURL(
  repoUrl: string,
  options: {
    id?: string;
    name?: string;
    branch?: string;
    enabled?: boolean;
    priority?: number;
    trust?: 'official' | 'community' | 'custom';
    resolved_at?: string;
    refresh_error?: string;
    accepted_at?: string;
  } = {}
): MarketSource {
  const trimmed = repoUrl.trim().replace(/\/$/, '').replace(/\.git$/, '');
  if (!trimmed) throw new Error('Market repo URL is required');

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('Market repo URL must be a valid URL');
  }

  if (parsed.protocol !== 'https:') throw new Error('Market repo URL must start with https://');

  const parts = parsed.pathname.replace(/^\/+|\/+$/g, '').split('/');
  if (parts.length < 2 || !parts[0] || !parts[1]) {
    throw new Error('Market repo URL must include owner and repository');
  }

  const baseUrl = `${parsed.protocol}//${parsed.host}`;
  const organization = parts[0];
  const repository = parts[1].replace(/\.git$/, '');

  const branch = (options.branch || DEFAULT_MARKET_BRANCH).trim() || DEFAULT_MARKET_BRANCH;
  if (!MARKET_REF_PATTERN.test(branch) || branch.includes('..') || branch.includes('//') || branch.endsWith('/')) {
    throw new Error('Market branch must be a safe branch name');
  }

  return {
    id: options.id || 'custom',
    name: options.name || repository,
    kind: 'git',
    repo_url: `${baseUrl}/${organization}/${repository}`,
    branch,
    enabled: options.enabled ?? true,
    priority: options.priority ?? 1,
    trust: options.trust === 'community' ? 'community' : 'custom',
    provider: detectProvider(baseUrl),
    base_url: baseUrl,
    organization,
    repository,
    resolved_at: options.resolved_at,
    refresh_error: options.refresh_error,
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
  return source.kind === 'channel'
    ? { id: source.id, enabled: source.enabled, trust: 'official', resolved_at: source.resolved_at, refresh_error: source.refresh_error }
    : { id: source.id, name: source.name, repo_url: source.repo_url, branch: source.branch, enabled: source.enabled,
        priority: source.priority, trust: source.trust, resolved_at: source.resolved_at, refresh_error: source.refresh_error,
        accepted_at: source.accepted_at };
}

function fromStored(entries: StoredMarketSource[]): MarketSource[] {
  const officialEntry = entries.find((entry) => entry.id === OFFICIAL_MARKET_SOURCE_ID || entry.trust === 'official' && !entry.repo_url);
  const custom = entries
    .filter((entry) => entry !== officialEntry && entry.id !== OFFICIAL_MARKET_SOURCE_ID && entry.trust !== 'official' && entry.repo_url)
    .map((entry, index) => parseMarketRepoURL(entry.repo_url!, {
      id: entry.id || `source-${index + 1}`,
      name: entry.name || `Market ${index + 1}`,
      branch: entry.branch,
      enabled: entry.enabled ?? true,
      priority: Math.max(1, entry.priority ?? index + 1),
      trust: entry.trust,
      resolved_at: entry.resolved_at,
      refresh_error: entry.refresh_error,
      accepted_at: typeof entry.accepted_at === 'string' && entry.accepted_at ? entry.accepted_at : undefined,
    }));
  return [officialMarketSource({ enabled: officialEntry?.enabled ?? true, resolved_at: officialEntry?.resolved_at, refresh_error: officialEntry?.refresh_error }), ...custom]
    .sort((a, b) => a.priority - b.priority);
}

async function readMarketSources(): Promise<MarketSource[]> {
  if (!existsSync(MARKET_SOURCES_PATH)) return [officialMarketSource()];
  const raw = JSON.parse(await readFile(MARKET_SOURCES_PATH, 'utf8')) as { active_sources?: StoredMarketSource[] };
  return fromStored(Array.isArray(raw.active_sources) ? raw.active_sources : []);
}

/**
 * The one write chain of the source list in this process. The module is bundled more than once (the API routes and
 * `instrumentation`'s background jobs each get a copy), so the chain lives on `globalThis`: a module-level chain per
 * copy would let a background resolution write a list read before an owner's add or edit, and revert it.
 */
const WRITE_CHAIN = Symbol.for('youeye.market-sources.write-chain');
const writeChainHolder = globalThis as typeof globalThis & { [WRITE_CHAIN]?: { tail: Promise<unknown> } };
const writeChain = writeChainHolder[WRITE_CHAIN] ??= { tail: Promise.resolve() };

/**
 * Read, change and write the source list as one step (one writer at a time in this process). The file is read inside
 * the serialised section. `change` returns null when nothing changes: then nothing is written.
 */
async function mutateMarketSources(change: (sources: MarketSource[]) => MarketSource[] | null): Promise<MarketSource[]> {
  const run = writeChain.tail.catch(() => undefined).then(async () => {
    const current = await readMarketSources();
    const next = change(current);
    if (!next) return current;
    await mkdir(MARKET_STATE_DIR, { recursive: true });
    await atomicWriteJSON(MARKET_SOURCES_PATH, { active_sources: next.map(stored) });
    return next;
  });
  writeChain.tail = run;
  return run;
}

/** The official source plus every custom source, in priority order. */
export async function getConfiguredMarketSources(): Promise<MarketSource[]> {
  return readMarketSources();
}

export async function getMarketSources(): Promise<MarketSource[]> {
  return (await getConfiguredMarketSources()).filter((source) => source.enabled);
}

/** One entry of the source list as a client sends it to `PATCH /api/market/source`. */
export interface MarketSourceListEntry {
  id?: unknown;
  name?: unknown;
  repo_url?: unknown;
  branch?: unknown;
  enabled?: unknown;
  priority?: unknown;
}

/**
 * The source list after a client's edit: sources can be enabled, disabled, renamed, reordered and removed. A source
 * cannot be created here (`addMarketSource` does that, with consent), and acceptance and refresh state are never
 * taken from the client. A custom source whose address or branch changes loses its acceptance. The official source
 * is always kept (it may be disabled).
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
    if (isChannelMarketSource(existing)) {
      next.push({ ...existing, enabled });
      continue;
    }
    const priority = Number.isFinite(Number(entry.priority)) && entry.priority !== null && entry.priority !== ''
      ? Math.max(1, Number(entry.priority)) : existing.priority;
    const name = typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : existing.name;
    const target = parseMarketRepoURL(typeof entry.repo_url === 'string' && entry.repo_url.trim() ? entry.repo_url : existing.repo_url, {
      branch: typeof entry.branch === 'string' && entry.branch.trim() ? entry.branch : existing.branch,
    });
    const retargeted = target.repo_url !== existing.repo_url || target.branch !== existing.branch;
    next.push(retargeted
      ? { ...target, id, name, enabled, priority, trust: existing.trust, accepted_at: undefined, resolved_at: undefined, refresh_error: undefined }
      : { ...existing, name, enabled, priority });
  }
  if (!seen.has(OFFICIAL_MARKET_SOURCE_ID)) next.push(current.find(isChannelMarketSource) ?? officialMarketSource());
  return next.sort((a, b) => a.priority - b.priority);
}

/** Apply a client's edit of the source list (see `applyMarketSourceListEdit`). */
export async function updateMarketSourceList(requested: MarketSourceListEntry[]): Promise<MarketSource[]> {
  return mutateMarketSources((current) => applyMarketSourceListEdit(current, requested));
}

const MARKET_SOURCE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

export interface NewMarketSource {
  repo_url: string;
  branch?: string;
  name?: string;
  /** Optional id (lowercase letters, digits, hyphens); generated when omitted. */
  id?: string;
}

/** Ids no custom source may take: the official source's, and `direct` (the source id prefix of apps added by URL). */
const RESERVED_MARKET_SOURCE_IDS = new Set([OFFICIAL_MARKET_SOURCE_ID, 'direct']);

/** A source id an installed app still records, with the repository it recorded (empty when none). */
export interface RecordedMarketSourceId {
  sourceId: string;
  sourceRepoUrl?: string | null;
}

/**
 * The source list with a new custom source, accepted at `acceptedAt`. Adding needs the owner's consent first.
 *
 * An installed app follows its source id, so an id an installed app still records (`recorded`) is never handed out
 * again: a generated id skips it, and a chosen one is refused unless it names the same repository the app recorded.
 */
export function withAddedMarketSource(
  current: MarketSource[], input: NewMarketSource, acceptedAt: string, recorded: RecordedMarketSourceId[] = [],
): MarketSource[] {
  const requestedId = input.id?.trim();
  if (requestedId !== undefined && requestedId !== '' && (!MARKET_SOURCE_ID_PATTERN.test(requestedId) || RESERVED_MARKET_SOURCE_IDS.has(requestedId))) {
    throw new Error('A Market source id uses lowercase letters, digits and hyphens (at most 32), and is not "official" or "direct"');
  }
  if (requestedId && current.some((source) => source.id === requestedId)) {
    throw new Error(`Market source "${requestedId}" already exists`);
  }
  if (requestedId) {
    const other = recorded.find((entry) => entry.sourceId === requestedId && !repositoriesMatch(entry.sourceRepoUrl, input.repo_url));
    if (other) {
      throw new Error(`An installed app still records Market source "${requestedId}" for ${other.sourceRepoUrl || 'another repository'}; choose another id`);
    }
  }
  const taken = (candidate: string) => current.some((source) => source.id === candidate)
    || recorded.some((entry) => entry.sourceId === candidate);
  let id = requestedId;
  for (let n = 1; !id; n++) {
    if (!taken(`custom-${n}`)) id = `custom-${n}`;
  }
  const priority = Math.max(0, ...current.map((source) => source.priority)) + 1;
  const source = parseMarketRepoURL(input.repo_url, {
    id, name: input.name?.trim() || undefined, branch: input.branch, enabled: true, priority, trust: 'custom', accepted_at: acceptedAt,
  });
  if (current.some((existing) => existing.repo_url === source.repo_url && existing.branch === source.branch)) {
    throw new Error('This repository and branch is already a Market source');
  }
  return [...current, source];
}

/** Source ids that installed apps record (installed-app store), with their repositories. */
async function recordedMarketSourceIds(): Promise<RecordedMarketSourceId[]> {
  // Loaded when needed: installed-apps imports the catalog, which imports this module.
  const { getAllInstalledApps } = await import('./installed-apps');
  return (await getAllInstalledApps()).flatMap((app) => {
    const sourceId = app.sourceId || app.catalogKey?.split(':')[0];
    return sourceId ? [{ sourceId, sourceRepoUrl: app.sourceRepoUrl }] : [];
  });
}

/** Add a custom source. The caller has the owner's consent (`acceptRisk`), so the source is accepted now. */
export async function addMarketSource(input: NewMarketSource): Promise<MarketSource> {
  const recorded = await recordedMarketSourceIds();
  const sources = await mutateMarketSources((current) => withAddedMarketSource(current, input, new Date().toISOString(), recorded));
  return sources[sources.length - 1];
}

/** The owner accepts an existing custom source: its apps may be installed and updated from now on. */
export async function acceptMarketSource(id: string): Promise<MarketSource> {
  let accepted: MarketSource | undefined;
  await mutateMarketSources((current) => current.map((source) => {
    if (source.id !== id) return source;
    if (isChannelMarketSource(source)) throw new Error('The official Market needs no acceptance');
    accepted = { ...source, accepted_at: source.accepted_at ?? new Date().toISOString() };
    return accepted;
  }));
  if (!accepted) throw new Error(`Market source "${id}" does not exist`);
  return accepted;
}

/** A successful refresh newer than this is not recorded again (the time is shown, not used). */
const RESOLUTION_RECORD_INTERVAL_MS = 60_000;

/**
 * Record a source's last refresh (every catalog fetch calls this). Read-modify-write inside the one write chain; no
 * write when nothing changed: the same error again, a success within a minute of the recorded one, or a source that
 * no longer exists.
 */
export async function recordMarketSourceResolution(sourceId: string, result: { ok?: boolean; error?: string }): Promise<void> {
  await mutateMarketSources((sources) => {
    const source = sources.find((candidate) => candidate.id === sourceId);
    if (!source) return null;
    const now = Date.now();
    const recent = !!source.resolved_at && now - Date.parse(source.resolved_at) >= 0
      && now - Date.parse(source.resolved_at) < RESOLUTION_RECORD_INTERVAL_MS;
    if ((source.refresh_error ?? undefined) === (result.error ?? undefined) && (!result.ok || recent)) return null;
    return sources.map((candidate) => candidate === source ? {
      ...candidate,
      ...(result.ok ? { resolved_at: new Date(now).toISOString() } : {}),
      refresh_error: result.error,
    } : candidate);
  });
}

// ─── Consent ─────────────────────────────────────────────

/**
 * Why an app may not be installed, updated or re-pointed from this source; null when it may.
 *
 * The one rule for Market sources: the official Market may always be used; a custom source only after the owner
 * accepted it (`accepted_at`); a disabled or missing source never. Apps added by URL (`direct:` source ids) are not
 * Market sources: each install asks for its own consent (`directAppRefusal`).
 */
export function marketSourceRefusal(source: MarketSource | null | undefined, sourceId?: string): MarketSourceConsentError | null {
  if (!source) return new MarketSourceConsentError('source-unavailable', `Market source "${sourceId ?? ''}" is not configured`);
  if (!source.enabled) return new MarketSourceConsentError('source-unavailable', `Market source "${source.name}" is turned off`);
  if (isChannelMarketSource(source)) return null;
  if (!source.accepted_at) {
    return new MarketSourceConsentError('source-not-accepted',
      `Market source "${source.name}" is not accepted: its apps are not checked by YouEye. Accept it first `
      + `(youeye market source accept ${source.id})`);
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

/** A Market source that may be used for an install or update; the official source when none is named. */
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
 * `source-changed`: the app's source id now names another repository than the app was installed from
 * (`recordedSourceRepositoryChange`); only an explicit switch of the app moves it.
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

export function isGitHubMarketSource(source: MarketSource): boolean {
  return source.provider === 'github';
}

/** Raw file of a custom (git) source. Plain web paths, never a forge API. */
export function buildMarketRawURL(source: MarketSource, owner: string, repo: string, filePath: string, branch: string): string {
  if (source.kind !== 'git') throw new Error('The official Market is read from its catalog release, not from git');
  const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
  if (isGitHubMarketSource(source)) {
    return `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(branch)}/${encodedPath}`;
  }
  return `${source.base_url}/${owner}/${repo}/raw/branch/${branch.split('/').map(encodeURIComponent).join('/')}/${encodedPath}`;
}

/** The ref a custom catalog entry is read from. */
export function catalogEntryRef(entry: { repo?: string; branch?: string }, catalogRef: string): string {
  if (!entry.repo) return catalogRef;
  return entry.branch || DEFAULT_MARKET_BRANCH;
}
