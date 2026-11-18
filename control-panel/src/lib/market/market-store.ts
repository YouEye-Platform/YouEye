/**
 * The box's copy of each market it reads (`youeye.market.v1`, market-format.ts).
 *
 *   /var/lib/youeye/markets/<sourceId>/
 *     state.json                   what is accepted: the market's address, its `sequence` (the floor for that
 *                                  address), the exact bytes of the accepted market.json, and its ETag
 *     refresh.json                 when the market was last asked, and why the last attempt failed
 *     h/index/<sha256>.json        the accepted index
 *     h/apps/<id>/<sha256>.json    every app bundle the index names
 *     h/files/<sha256>.<ext>       the pictures fetched so far
 *     attempt-<pid>-<random>/      the bundles a running refresh has fetched; gone when the refresh ends
 *
 * Accepting (`refreshMarket`): fetch market.json (304: nothing to do) → refuse a `sequence` more than a day ahead of
 * this box's clock, or lower than the floor of the same address → fetch the index and check its size and SHA-256 →
 * fetch every bundle that is not in the store yet into the attempt's own directory and check each → move them under
 * their hashed names → write `state.json` → remove what the new index no longer names. Nothing under `h/` changes
 * until every file of the new state is on this box, and `state.json` is replaced in one rename, so the store always
 * holds one complete market: the old one until that rename, the new one after it. A market that cannot be reached or
 * is not valid keeps the accepted state and leaves nothing behind: the attempt's directory is removed, and `h/` holds
 * only what the accepted state names (nothing when no state is accepted). The reason is recorded in `refresh.json`.
 *
 * A refresh ends within `MARKET_REFRESH_DEADLINE_MS`, whatever the market does. It belongs to one source at one
 * address: a source that was removed, or whose id now reads another address, is never answered from it, and such a
 * refresh commits nothing.
 *
 * The floor belongs to the address. When a source's address changes (the official Market after a channel change, or
 * a custom market the owner re-pointed), the next accept starts a new floor and replaces the store.
 *
 * Reading (`readAcceptedMarket`) checks every file against the hash that names it, once per accepted state (kept in
 * memory by the hash of `state.json`). `currentMarket` adds the refresh policy: at most one refresh per source every
 * five minutes plus up to 10 % jitter, in the background; a caller waits for the network only when the store is
 * empty or after an explicit "check for updates" (`requestMarketRefresh`), and then for `MARKET_READER_WAIT_MS` at
 * most.
 *
 * One Control Panel process owns these files. Its bundle holds this module more than once, so everything shared
 * (the running refresh per source, the timers, the in-memory copies) lives on `globalThis`.
 */

import { access, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import {
  MARKET_LIMITS, MARKET_POINTER_FILE, fileHashOf, readMarketAppBundle, readMarketIndex, readMarketPointer, sha256Hex,
  type MarketAppBundle, type MarketIndex, type MarketIndexEntry, type MarketPointer,
} from './market-format';
import { openMarketSession, type MarketFetchDeps, type MarketSession } from './market-fetch';
import {
  OFFICIAL_MARKET_AS_CUSTOM, OFFICIAL_MARKET_SOURCE_ID, getConfiguredMarketSources, isOfficialMarketAddress, isOfficialMarketLane,
  isOfficialMarketSource, marketSourceRefusal, marketStateDir, officialMarketAddress,
  type MarketSource, type ReleaseChannelClient,
} from './source';

const STORE_SCHEMA = 'youeye.market-store.v1';
const STATE_FILE = 'state.json';
const REFRESH_FILE = 'refresh.json';

/** A market is asked at most this often (plus jitter), whatever reads it. */
export const MARKET_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
/** Each wait is longer by a random 0–10 %, so boxes do not ask in step. */
export const MARKET_REFRESH_JITTER = 0.1;
/** With nothing in the store yet (first use), a failed attempt is repeated sooner. */
const EMPTY_STORE_RETRY_MS = 30 * 1000;
/** An explicit check that follows an attempt this recent uses its result. */
const EXPLICIT_REFRESH_COALESCE_MS = 15 * 1000;
/**
 * One refresh (market.json, the index and every missing bundle) ends within this time, successful or not; what it
 * fetched until then is dropped. Three minutes carry the largest market this reader accepts (64 MiB of bundles) at
 * about 3 Mbit/s, are far above what the official Market needs (seconds), and stay under the five minutes between
 * refreshes, so attempts never pile up.
 */
export const MARKET_REFRESH_DEADLINE_MS = 3 * 60 * 1000;
/**
 * A reader waits this long at most for a market that is being read (an empty store, or after an explicit check).
 * Then it gets what the store holds, or the reason there is nothing, and the refresh goes on in the background up
 * to its deadline. One slow market therefore delays a listing of every source by 20 seconds at most.
 */
export const MARKET_READER_WAIT_MS = 20 * 1000;
/**
 * `sequence` is the market's commit time. A pointer dated more than this far ahead of the box's clock is refused:
 * accepted, it would be a floor no honest later state of the market could reach.
 */
export const MARKET_SEQUENCE_AHEAD_SECONDS = 24 * 60 * 60;

/** What this reader accepts from one market beyond the per-file limits of the format. */
export const MARKET_STORE_LIMITS = {
  /** Apps in one index. */
  apps: 2000,
  /** Native app ids and bundle definitions in one index. */
  native: 200,
  bundles: 500,
  /** All bundles of one index together. */
  bundleBytes: 64 * 1024 * 1024,
  /** Pictures kept for one market. */
  pictureBytes: 512 * 1024 * 1024,
} as const;

const BUNDLE_FETCH_CONCURRENCY = 4;
const PICTURE_FAILURE_MEMORY_MS = 60 * 1000;
/**
 * Pictures fetched from markets at the same time, by the whole box and from one market. A picture may be 5 MiB and
 * the image route needs no sign-in, so this is what bounds the bodies held in memory (4 × 5 MiB). One market gets
 * three of the four places at most: a market that serves its pictures slowly never keeps the others' from loading.
 */
export const PICTURE_FETCH_LIMITS = { all: 4, perSource: 3 } as const;
/** A picture request waits this long for a place, and at most this many wait; beyond either the answer is "busy". */
const PICTURE_QUEUE_WAIT_MS = 20 * 1000;
const PICTURE_QUEUE_LENGTH = 200;
const PICTURE_BUSY_RETRY_SECONDS = 5;
const TEMPORARY_FILE_AGE_MS = 10 * 60 * 1000;
const ATTEMPT_DIRECTORY = /^attempt-\d+-[0-9a-f]+$/;
const STILL_READING = 'The market is still being read; this box keeps reading it in the background';
const NOT_THIS_SOURCE = 'This Market source was removed or now reads another address';
const NO_ANSWER_IN_TIME = 'The market did not answer in time';
const SOURCE_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

interface StoreRecord {
  schema: typeof STORE_SCHEMA;
  /** The market address this state was accepted from. */
  address: string;
  /** `sequence` of the accepted market.json: nothing lower is accepted from `address`. */
  sequence: number;
  pointer_base64: string;
  pointer_sha256: string;
  etag?: string;
  accepted_at: string;
}

export interface MarketRefreshStatus {
  /** The last attempt, successful or not (ISO time). */
  checked_at?: string;
  /** The last attempt that reached the market and found its state acceptable. */
  refreshed_at?: string;
  /** Why the last attempt failed; absent after a success. */
  error?: string;
}

/** A stored bundle: the document, or why its file cannot be used. */
export type StoredBundle = { ok: true; bundle: MarketAppBundle } | { ok: false; reason: string };

/** The accepted state of one market, every file verified against the hash that names it. */
export interface AcceptedMarket {
  sourceId: string;
  address: string;
  pointer: MarketPointer;
  pointerSHA256: string;
  etag?: string;
  acceptedAt: string;
  index: MarketIndex;
  /** By app id, for every index entry that names a bundle. */
  bundles: Map<string, StoredBundle>;
  /** Every picture path (`h/files/…`) the index or a stored bundle names. */
  pictures: Set<string>;
  /** Hashed files the accepted state names that are missing or differ on disk. The next refresh fetches them again. */
  damaged: string[];
}

/**
 * A refresh was refused or failed. The message is safe to show; the accepted state is unchanged.
 *
 * `code: 'official-market'` marks the one refusal a caller may want to tell apart: the address is a lane of the
 * official YouEye Market, which is never added as a custom market (`isOfficialMarketRefusal`).
 */
export class MarketRefreshError extends Error {
  constructor(message: string, readonly code?: 'official-market') {
    super(message);
    this.name = 'MarketRefreshError';
  }
}

/** True for the refusal of an official lane as a custom market (`previewMarket`). By name and code: the module is bundled more than once. */
export function isOfficialMarketRefusal(error: unknown): error is MarketRefreshError {
  return error instanceof Error && error.name === 'MarketRefreshError' && (error as { code?: unknown }).code === 'official-market';
}

/**
 * Pictures are being fetched from markets at the limit (`PICTURE_FETCH_LIMITS`) and this one found no place in
 * time. Nothing is wrong with the picture: the caller may ask again after `retryAfterSeconds`.
 */
export class MarketBusyError extends Error {
  readonly retryAfterSeconds = PICTURE_BUSY_RETRY_SECONDS;
  constructor() {
    super('Too many pictures are being fetched from markets right now; try again in a moment');
    this.name = 'MarketBusyError';
  }
}

/** Fetch and refresh failures keep their message; anything else is a fault of this box and is passed on as it is. */
function asRefreshError(error: unknown): unknown {
  // By name: the module is bundled more than once, and a shared refresh may be awaited from another copy.
  if (error instanceof Error && error.name === 'MarketRefreshError') return error;
  if (error instanceof Error && error.name === 'MarketFetchError') return new MarketRefreshError(error.message);
  return error;
}

export interface MarketStoreOptions {
  deps?: MarketFetchDeps;
  /** Asked for the box's channel (the official Market's lane). */
  channel?: ReleaseChannelClient;
  now?: () => number;
  /** 0 ≤ value < 1; the jitter of the next wait. */
  random?: () => number;
  /** Tests: other times than `MARKET_REFRESH_DEADLINE_MS`, `MARKET_READER_WAIT_MS` and the wait for a picture place. */
  refreshDeadlineMs?: number;
  readerWaitMs?: number;
  pictureWaitMs?: number;
}

// ─── Shared state of this process ─────────────────────────

interface SourceSchedule {
  /** Loaded from refresh.json once per process. */
  loaded: boolean;
  lastAttemptAt: number;
  nextDueAt: number;
  lastError?: string;
  /** The last attempt failed after readers had stopped waiting for it: an empty store no longer makes them wait. */
  slow?: boolean;
  /** The custom market address the timer belongs to: a source that was re-pointed starts over. */
  url?: string;
}

/** Ends a refresh from outside (its deadline, the removal of its source): every wait of it fails with `reason`. */
interface StopSignal {
  reason?: string;
  /** Never resolves; rejects with a `MarketRefreshError` once stopped. */
  stopped: Promise<never>;
  trigger(reason: string): void;
}

interface RunningRefresh {
  promise: Promise<AcceptedMarket>;
  sourceId: string;
  /** Wall-clock start: readers of an empty store wait `MARKET_READER_WAIT_MS` from here, not from their arrival. */
  startedAt: number;
  stop: StopSignal;
}

interface PictureWaiter {
  sourceKey: string;
  grant: () => void;
}

interface Shared {
  /** The running refreshes by source id AND address (`refreshKey`): never by the id alone. */
  refreshing: Map<string, RunningRefresh>;
  schedule: Map<string, SourceSchedule>;
  accepted: Map<string, { key: string; address: string; accepted: AcceptedMarket | null }>;
  /** Per source id: the tail of the file changes that must not interleave (a commit, the tidying after a failure). */
  locks: Map<string, Promise<unknown>>;
  /** The attempt directories of the refreshes running in this process. */
  attempts: Set<string>;
  pictures: Map<string, Promise<Buffer>>;
  pictureFailures: Map<string, { until: number; message: string }>;
  /** Pictures being fetched from markets now: in all, and per source; and the requests waiting for a place. */
  pictureFetches: { all: number; bySource: Map<string, number>; waiting: PictureWaiter[] };
  /** `requestMarketRefresh` was called at this time, for every source or for one: a source asked before it is asked again. */
  requestedAt: number;
  requestedFor: Map<string, number>;
  oldFilesRemoved: boolean;
}

const SHARED = Symbol.for('youeye.market-store');
const holder = globalThis as typeof globalThis & { [SHARED]?: Shared };
const shared: Shared = holder[SHARED] ??= {
  refreshing: new Map(), schedule: new Map(), accepted: new Map(), locks: new Map(), attempts: new Set(),
  pictures: new Map(), pictureFailures: new Map(), pictureFetches: { all: 0, bySource: new Map(), waiting: [] },
  requestedAt: 0, requestedFor: new Map(), oldFilesRemoved: false,
};

/** Forget everything kept in memory (tests). Files stay; a refresh that is still running ends without committing. */
export function resetMarketStoreMemory(): void {
  for (const running of shared.refreshing.values()) running.stop.trigger(NOT_THIS_SOURCE);
  shared.refreshing.clear();
  shared.schedule.clear();
  shared.accepted.clear();
  shared.locks.clear();
  shared.pictures.clear();
  shared.pictureFailures.clear();
  shared.pictureFetches = { all: 0, bySource: new Map(), waiting: [] };
  shared.requestedAt = 0;
  shared.requestedFor.clear();
  shared.oldFilesRemoved = false;
}

// ─── Files ────────────────────────────────────────────────

export function marketStoreDirectory(sourceId: string): string {
  if (!SOURCE_ID.test(sourceId)) throw new Error(`Invalid Market source id "${sourceId}"`);
  return path.join(marketStateDir(), 'markets', sourceId);
}

const scope = (sourceId: string) => `${marketStoreDirectory(sourceId)}\0`;

/**
 * What a running refresh belongs to: the source AND the address it reads. Two markets that had the same source id
 * one after the other (a custom market removed and another added, or one re-pointed) never share a refresh. The
 * official Market's address follows the box's channel and is always an official lane, so its refreshes are one.
 */
const refreshKey = (source: Pick<MarketSource, 'id' | 'kind' | 'url'>) =>
  `${scope(source.id)}${isOfficialMarketSource(source) ? 'official' : source.url}`;

function stopSignal(): StopSignal {
  let fail!: (error: Error) => void;
  const stopped = new Promise<never>((_resolve, reject) => { fail = reject; });
  stopped.catch(() => {});
  const signal: StopSignal = {
    stopped,
    trigger(reason) {
      if (signal.reason !== undefined) return;
      signal.reason = reason;
      fail(new MarketRefreshError(reason));
    },
  };
  return signal;
}

/** `work`, or a `MarketRefreshError` with `message` after `ms`. `work` goes on either way; its failure is the caller's to record. */
function within<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  work.catch(() => {});
  if (!(ms > 0)) return Promise.reject(new MarketRefreshError(message));
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new MarketRefreshError(message)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * One at a time per source id: the file changes that must see the store as nobody else is changing it (a commit and
 * its tidying, the tidying after a failed attempt). Only local file work runs inside, never a request.
 */
function withStoreLock<T>(sourceId: string, work: () => Promise<T>): Promise<T> {
  const key = scope(sourceId);
  const run = (shared.locks.get(key) ?? Promise.resolve()).then(work);
  const tail = run.catch(() => {});
  shared.locks.set(key, tail);
  void tail.then(() => { if (shared.locks.get(key) === tail) shared.locks.delete(key); });
  return run;
}

async function readOptional(file: string, maximum: number): Promise<Buffer | null> {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > maximum) return null;
    return await readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Write a file under its final name in one rename. `durable` also syncs it (the commit record). */
async function writeAtomically(file: string, bytes: Buffer | string, durable = false): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  try {
    if (durable) {
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    } else {
      await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' });
    }
    await rename(temporary, file);
    if (durable) {
      const directory = await open(path.dirname(file), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

/** A hashed file of the store, or null when it is missing or is not what its name says. */
async function readHashed(directory: string, ref: { path: string; sha256: string; size: number }): Promise<Buffer | null> {
  const bytes = await readOptional(path.join(directory, ref.path), ref.size);
  return bytes && bytes.byteLength === ref.size && sha256Hex(bytes) === ref.sha256 ? bytes : null;
}

function parseRecord(raw: Buffer): { record: StoreRecord; pointerBytes: Buffer; pointer: MarketPointer } | null {
  try {
    const record = JSON.parse(raw.toString('utf8')) as StoreRecord;
    if (record?.schema !== STORE_SCHEMA || typeof record.address !== 'string' || typeof record.pointer_base64 !== 'string') return null;
    const pointerBytes = Buffer.from(record.pointer_base64, 'base64');
    if (sha256Hex(pointerBytes) !== record.pointer_sha256) return null;
    const pointer = readMarketPointer(pointerBytes);
    if (pointer.sequence !== record.sequence) return null;
    return { record, pointerBytes, pointer };
  } catch {
    return null;
  }
}

const MAX_STATE_BYTES = 1024 * 1024;

async function readRecord(directory: string) {
  const raw = await readOptional(path.join(directory, STATE_FILE), MAX_STATE_BYTES);
  return raw ? parseRecord(raw) : null;
}

/** Picture paths a bundle names, read without the bundle's schema (a bundle this reader does not understand still names pictures). */
function picturesOf(bytes: Buffer): string[] {
  try {
    const files = (JSON.parse(bytes.toString('utf8')) as { files?: unknown })?.files;
    if (!files || typeof files !== 'object' || Array.isArray(files)) return [];
    return Object.values(files).filter((value): value is string => typeof value === 'string' && fileHashOf(value) !== null);
  } catch {
    return [];
  }
}

function indexLimitProblem(index: MarketIndex): string | null {
  if (index.apps.length > MARKET_STORE_LIMITS.apps) return `the index lists ${index.apps.length} apps, more than the ${MARKET_STORE_LIMITS.apps} this box accepts`;
  if (index.native.length > MARKET_STORE_LIMITS.native) return `the index lists ${index.native.length} native apps, more than the ${MARKET_STORE_LIMITS.native} this box accepts`;
  if (index.bundles.length > MARKET_STORE_LIMITS.bundles) return `the index lists ${index.bundles.length} bundles, more than the ${MARKET_STORE_LIMITS.bundles} this box accepts`;
  const total = index.apps.reduce((sum, entry) => sum + (entry.bundle?.size ?? 0), 0);
  if (total > MARKET_STORE_LIMITS.bundleBytes) return `the app bundles are ${total} bytes together, more than the ${MARKET_STORE_LIMITS.bundleBytes} this box accepts`;
  return null;
}

/** Build the accepted state from the store's files, checking each against its hash. Null when the index is unusable. */
async function loadAccepted(sourceId: string, directory: string, parsed: NonNullable<ReturnType<typeof parseRecord>>): Promise<AcceptedMarket | null> {
  const { record, pointer } = parsed;
  const indexBytes = await readHashed(directory, pointer.index);
  if (!indexBytes) return null;
  let index: MarketIndex;
  try { index = readMarketIndex(indexBytes); } catch { return null; }
  const bundles = new Map<string, StoredBundle>();
  const pictures = new Set<string>();
  const damaged: string[] = [];
  for (const entry of index.apps) {
    if (entry.icon) pictures.add(entry.icon);
    if (!entry.bundle) continue;
    const bytes = await readHashed(directory, entry.bundle);
    if (!bytes) {
      damaged.push(entry.bundle.path);
      bundles.set(entry.id, { ok: false, reason: 'its bundle is missing from this box\'s copy of the market' });
      continue;
    }
    for (const picture of picturesOf(bytes)) pictures.add(picture);
    try { bundles.set(entry.id, { ok: true, bundle: readMarketAppBundle(bytes) }); }
    catch (error) { bundles.set(entry.id, { ok: false, reason: error instanceof Error ? error.message : String(error) }); }
  }
  return {
    sourceId, address: record.address, pointer, pointerSHA256: record.pointer_sha256,
    ...(record.etag ? { etag: record.etag } : {}), acceptedAt: record.accepted_at, index, bundles, pictures, damaged,
  };
}

/** The address the source's store must hold: a custom market's own; any official lane for the official Market. */
function addressBelongs(source: Pick<MarketSource, 'kind' | 'url'>, address: string): boolean {
  return isOfficialMarketSource(source) ? isOfficialMarketAddress(address) : address === source.url;
}

/** What the store of a source id holds, whatever address it was accepted from; null when it holds no usable state. */
async function readStoredMarket(sourceId: string): Promise<AcceptedMarket | null> {
  const directory = marketStoreDirectory(sourceId);
  const raw = await readOptional(path.join(directory, STATE_FILE), MAX_STATE_BYTES);
  if (!raw) return null;
  // Verified once per state: the copy in memory answers while state.json has the bytes it was built from.
  const key = sha256Hex(raw);
  const cached = shared.accepted.get(scope(sourceId));
  if (cached?.key === key) return cached.accepted;
  const parsed = parseRecord(raw);
  if (!parsed) return null;
  const accepted = await loadAccepted(sourceId, directory, parsed);
  shared.accepted.set(scope(sourceId), { key, address: parsed.record.address, accepted });
  return accepted;
}

/**
 * The accepted state of a source from its store, or null when there is none (never refreshed, the files are
 * unusable, or they were accepted from another address than the source has now). Never asks the network.
 */
export async function readAcceptedMarket(source: Pick<MarketSource, 'id' | 'kind' | 'url'>): Promise<AcceptedMarket | null> {
  const accepted = await readStoredMarket(source.id);
  return accepted && addressBelongs(source, accepted.address) ? accepted : null;
}

export async function readMarketRefreshStatus(sourceId: string): Promise<MarketRefreshStatus> {
  const raw = await readOptional(path.join(marketStoreDirectory(sourceId), REFRESH_FILE), 64 * 1024).catch(() => null);
  if (!raw) return {};
  try {
    const status = JSON.parse(raw.toString('utf8')) as MarketRefreshStatus;
    return {
      ...(typeof status.checked_at === 'string' ? { checked_at: status.checked_at } : {}),
      ...(typeof status.refreshed_at === 'string' ? { refreshed_at: status.refreshed_at } : {}),
      ...(typeof status.error === 'string' ? { error: status.error } : {}),
    };
  } catch {
    return {};
  }
}

async function recordAttempt(sourceId: string, at: number, error?: string): Promise<void> {
  try {
    const previous = await readMarketRefreshStatus(sourceId);
    const now = new Date(at).toISOString();
    await writeAtomically(path.join(marketStoreDirectory(sourceId), REFRESH_FILE), `${JSON.stringify({
      checked_at: now,
      ...(error ? { ...(previous.refreshed_at ? { refreshed_at: previous.refreshed_at } : {}), error } : { refreshed_at: now }),
    } satisfies MarketRefreshStatus, null, 2)}\n`);
  } catch (failure) {
    console.warn(`[market] Could not record the refresh of ${sourceId}:`, failure);
  }
}

// ─── Accepting ────────────────────────────────────────────

async function mapLimited<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failure: unknown;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length && failure === undefined) {
      const item = items[next++];
      try { await work(item); } catch (error) { failure ??= error; }
    }
  }));
  if (failure !== undefined) throw failure;
}

async function fetchHashed(session: MarketSession, ref: { path: string; sha256: string; size: number }, kind: 'index' | 'bundle' | 'file', what: string): Promise<Buffer> {
  const file = await session.get(ref.path, kind, { maxBytes: ref.size });
  if (file.status !== 'ok') throw new MarketRefreshError(`${what} could not be fetched`);
  if (file.bytes.byteLength !== ref.size || sha256Hex(file.bytes) !== ref.sha256) {
    throw new MarketRefreshError(`${what} is not the file its hash names (${ref.path})`);
  }
  return file.bytes;
}

/** Remove hashed files the accepted state does not name, and temporary files left by an interrupted write. */
async function removeUnnamed(directory: string, accepted: AcceptedMarket, now: number): Promise<void> {
  const named = new Set<string>([accepted.pointer.index.path, ...accepted.pictures]);
  for (const entry of accepted.index.apps) if (entry.bundle) named.add(entry.bundle.path);
  const walk = async (relative: string): Promise<void> => {
    let names: string[];
    try { names = await readdir(path.join(directory, relative)); } catch { return; }
    for (const name of names) {
      const child = `${relative}/${name}`;
      const full = path.join(directory, child);
      const info = await stat(full).catch(() => null);
      if (!info) continue;
      if (info.isDirectory()) {
        await walk(child);
        await readdir(full).then((rest) => (rest.length === 0 ? rm(full, { recursive: true, force: true }) : undefined)).catch(() => {});
      } else if (/\.tmp-\d+-[0-9a-f]+$/.test(name)) {
        if (now - info.mtimeMs > TEMPORARY_FILE_AGE_MS) await rm(full, { force: true }).catch(() => {});
      } else if (!named.has(child)) {
        await rm(full, { force: true }).catch(() => {});
      }
    }
  };
  await walk('h');
}

interface AcceptOutcome { accepted: AcceptedMarket; changed: boolean }

const exists = (file: string) => access(file).then(() => true, () => false);

/** Attempt directories nothing in this process is writing: what a refresh left when the process ended under it. */
async function removeStaleAttempts(directory: string): Promise<void> {
  const names = await readdir(directory).catch(() => [] as string[]);
  for (const name of names) {
    const full = path.join(directory, name);
    if (!ATTEMPT_DIRECTORY.test(name) || shared.attempts.has(full)) continue;
    const info = await stat(full).catch(() => null);
    if (info && Date.now() - info.mtimeMs > TEMPORARY_FILE_AGE_MS) await rm(full, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * After a failed attempt, `h/` holds only what the accepted state names, and nothing when no state is accepted. The
 * attempt itself wrote into its own directory; this removes what an attempt cut off in its commit left behind.
 */
async function tidyStore(sourceId: string, now: number): Promise<void> {
  await withStoreLock(sourceId, async () => {
    const directory = marketStoreDirectory(sourceId);
    if (!await readRecord(directory)) {
      await rm(path.join(directory, 'h'), { recursive: true, force: true });
      return;
    }
    const accepted = await readStoredMarket(sourceId);
    if (accepted) await removeUnnamed(directory, accepted, now);
  });
}

/**
 * False once the source list holds this id with another address: the market was re-pointed, or removed and its id
 * given to another one. A source the list does not hold was removed (`removeMarketStoresExcept` stops its refresh)
 * or never came from the list.
 */
async function stillConfigured(source: Pick<MarketSource, 'id' | 'kind' | 'url'>): Promise<boolean> {
  if (isOfficialMarketSource(source)) return true;
  try {
    const configured = (await getConfiguredMarketSources()).find((candidate) => candidate.id === source.id);
    return !configured || (!isOfficialMarketSource(configured) && configured.url === source.url);
  } catch {
    return true;
  }
}

/** Why a pointer dated `sequence` is not accepted at `now` (ms), or null. `sequence` is the market's commit time in seconds. */
function futureSequenceProblem(sequence: number, now: number): string | null {
  if (sequence - Math.floor(now / 1000) <= MARKET_SEQUENCE_AHEAD_SECONDS) return null;
  return `${MARKET_POINTER_FILE} is dated ${sequenceDate(sequence)} (sequence ${sequence}), more than a day ahead of this YouEye's clock `
    + `(${new Date(now).toISOString()}); a market's state cannot come from the future. If the date and time of this YouEye are wrong, `
    + 'correct them and check again';
}

async function accept(source: MarketSource, options: MarketStoreOptions, now: number, stop: StopSignal): Promise<AcceptOutcome> {
  const directory = marketStoreDirectory(source.id);
  /** Every wait for the network ends when the refresh is stopped (its deadline, the removal of its source). */
  const guarded = <T>(work: Promise<T>): Promise<T> => Promise.race([work, stop.stopped]);
  /** state.json changes only for a refresh that is still running for the address its source has. */
  const stillWanted = async () => {
    if (stop.reason !== undefined) throw new MarketRefreshError(stop.reason);
    if (!await stillConfigured(source)) throw new MarketRefreshError(NOT_THIS_SOURCE);
  };
  await removeStaleAttempts(directory);
  const stored = await readRecord(directory);
  const address = isOfficialMarketSource(source)
    ? (await guarded(officialMarketAddress(stored?.record.address, options.channel))).address
    : source.url;
  const sameAddress = stored?.record.address === address;
  const prior = stored && sameAddress ? await loadAccepted(source.id, directory, stored) : null;
  const intact = !!prior && prior.damaged.length === 0;

  const opening = openMarketSession(address, options.deps);
  let session: MarketSession;
  try { session = await guarded(opening); }
  catch (error) {
    void opening.then((late) => late.close(), () => {});
    throw asRefreshError(error);
  }
  // A stopped refresh takes its connections with it.
  stop.stopped.catch(() => session.close());
  // What this attempt fetches stays in its own directory until the commit: a failure leaves nothing under h/.
  const attempt = path.join(directory, `attempt-${process.pid}-${randomBytes(6).toString('hex')}`);
  shared.attempts.add(attempt);
  try {
    const answer = await guarded(session.get(MARKET_POINTER_FILE, 'pointer', { etag: intact ? stored!.record.etag : undefined }));
    if (answer.status === 'not-modified') return { accepted: prior!, changed: false };
    const pointerSHA256 = sha256Hex(answer.bytes);
    if (intact && pointerSHA256 === stored!.record.pointer_sha256) {
      if (answer.etag !== stored!.record.etag) {
        // The same market.json under a new ETag (the host was redeployed): only the ETag is recorded.
        const record: StoreRecord = { ...stored!.record };
        if (answer.etag) record.etag = answer.etag; else delete record.etag;
        await withStoreLock(source.id, async () => {
          await stillWanted();
          // Only while the store still holds the state this attempt read.
          const current = await readRecord(directory);
          if (current?.record.address !== address || current.record.pointer_sha256 !== pointerSHA256) return;
          await writeAtomically(path.join(directory, STATE_FILE), `${JSON.stringify(record, null, 2)}\n`, true);
          shared.accepted.delete(scope(source.id));
        });
      }
      return { accepted: prior!, changed: false };
    }

    let pointer: MarketPointer;
    try { pointer = readMarketPointer(answer.bytes); }
    catch (error) { throw new MarketRefreshError(error instanceof Error ? error.message : String(error)); }
    const fromTheFuture = futureSequenceProblem(pointer.sequence, now);
    if (fromTheFuture) throw new MarketRefreshError(fromTheFuture);
    // The floor counts for this address even when the stored files are damaged.
    if (stored && sameAddress && pointer.sequence < stored.record.sequence) {
      throw new MarketRefreshError(`${MARKET_POINTER_FILE} has sequence ${pointer.sequence}, lower than the ${stored.record.sequence} this box accepted from ${address}; an older state of a market is not accepted`);
    }

    const storedIndex = await readHashed(directory, pointer.index);
    const indexBytes = storedIndex ?? await guarded(fetchHashed(session, pointer.index, 'index', 'The index'));
    let index: MarketIndex;
    try { index = readMarketIndex(indexBytes); }
    catch (error) { throw new MarketRefreshError(error instanceof Error ? error.message : String(error)); }
    const tooLarge = indexLimitProblem(index);
    if (tooLarge) throw new MarketRefreshError(`This market is too large: ${tooLarge}`);

    // A bundle the store already holds is not fetched again; the others go into the attempt's directory.
    const missing: MarketIndexEntry[] = [];
    for (const entry of index.apps) {
      if (entry.bundle && !await readHashed(directory, entry.bundle)) missing.push(entry);
    }
    await mapLimited(missing, BUNDLE_FETCH_CONCURRENCY, async (entry) => {
      const bytes = await guarded(fetchHashed(session, entry.bundle!, 'bundle', `The bundle of ${entry.id}`));
      await writeAtomically(path.join(attempt, entry.bundle!.path), bytes);
    });
    const fetched = new Set(missing.map((entry) => entry.bundle!.path));

    const record: StoreRecord = {
      schema: STORE_SCHEMA, address, sequence: pointer.sequence,
      pointer_base64: answer.bytes.toString('base64'), pointer_sha256: pointerSHA256,
      ...(answer.etag ? { etag: answer.etag } : {}), accepted_at: new Date(now).toISOString(),
    };
    const accepted = await withStoreLock(source.id, async () => {
      await stillWanted();
      // What the store held when this attempt looked is still there (the tidying of another attempt may have removed it).
      for (const entry of index.apps) {
        if (entry.bundle && !fetched.has(entry.bundle.path) && !await exists(path.join(directory, entry.bundle.path))) {
          throw new MarketRefreshError('This box\'s copy of the market changed while the market was being read; it is read again shortly');
        }
      }
      // Every file of the new state takes its hashed name; nothing refers to them until state.json does.
      for (const file of fetched) {
        await mkdir(path.dirname(path.join(directory, file)), { recursive: true, mode: 0o700 });
        await rename(path.join(attempt, file), path.join(directory, file));
      }
      const indexFile = path.join(directory, pointer.index.path);
      if (!storedIndex || !await exists(indexFile)) await writeAtomically(indexFile, indexBytes);
      // The commit: from this rename on, the store is the new market.
      await writeAtomically(path.join(directory, STATE_FILE), `${JSON.stringify(record, null, 2)}\n`, true);
      shared.accepted.delete(scope(source.id));
      const committed = await readAcceptedMarket({ id: source.id, kind: source.kind, url: address });
      if (!committed) throw new MarketRefreshError('The market was fetched, but this box\'s copy of it cannot be read back');
      await removeUnnamed(directory, committed, now).catch((error) => console.warn(`[market] Could not tidy the store of ${source.id}:`, error));
      return committed;
    });
    if (index.warnings.length) console.warn(`[market] ${source.id}: ${index.warnings.length} index entries skipped: ${index.warnings.slice(0, 5).join(' | ')}`);
    console.log(`[market] ${source.id}: accepted ${address} at sequence ${pointer.sequence}${pointer.commit ? ` (${pointer.commit})` : ''}; ${missing.length} of ${index.apps.filter((entry) => entry.bundle).length} bundles fetched`);
    return { accepted, changed: true };
  } catch (error) {
    // A stopped refresh says why it was stopped, not what its last request died of.
    throw stop.reason !== undefined ? new MarketRefreshError(stop.reason) : asRefreshError(error);
  } finally {
    session.close();
    await rm(attempt, { recursive: true, force: true }).catch(() => {});
    shared.attempts.delete(attempt);
  }
}

function scheduleOf(sourceId: string): SourceSchedule {
  let schedule = shared.schedule.get(scope(sourceId));
  if (!schedule) {
    schedule = { loaded: false, lastAttemptAt: 0, nextDueAt: 0 };
    shared.schedule.set(scope(sourceId), schedule);
  }
  return schedule;
}

/** The time to wait after an attempt: the interval plus 0–10 % of it. */
export function marketRefreshWait(random: () => number = Math.random, base = MARKET_REFRESH_INTERVAL_MS): number {
  return Math.round(base * (1 + Math.min(Math.max(random(), 0), 1) * MARKET_REFRESH_JITTER));
}

/**
 * Bring a source's store to the market's current state now. One refresh per source and address runs at a time;
 * callers that arrive meanwhile get the same one. It ends within `MARKET_REFRESH_DEADLINE_MS`. Throws
 * `MarketRefreshError` (the store keeps what it had, and nothing the attempt fetched stays).
 */
export function refreshMarket(source: MarketSource, options: MarketStoreOptions = {}): Promise<AcceptedMarket> {
  const key = refreshKey(source);
  const running = shared.refreshing.get(key);
  if (running) return running.promise;
  const now = options.now ?? Date.now;
  const started = now();
  const startedAt = Date.now();
  const stop = stopSignal();
  const deadlineMs = options.refreshDeadlineMs ?? MARKET_REFRESH_DEADLINE_MS;
  const deadline = setTimeout(() => stop.trigger(`The market did not finish answering within ${Math.round(deadlineMs / 1000)} seconds`), deadlineMs);
  deadline.unref?.();
  const run: RunningRefresh = { promise: undefined as unknown as Promise<AcceptedMarket>, sourceId: source.id, startedAt, stop };
  run.promise = (async () => {
    const schedule = scheduleOf(source.id);
    schedule.loaded = true;
    schedule.lastAttemptAt = started;
    schedule.url = source.url;
    /** The outcome is the source's (its timer, its refresh.json) only while the source still reads this address. */
    const mine = async () => stop.reason !== NOT_THIS_SOURCE && schedule.url === source.url && await stillConfigured(source);
    try {
      const { accepted } = await accept(source, options, started, stop);
      if (!addressBelongs(source, accepted.address)) throw new MarketRefreshError(NOT_THIS_SOURCE);
      if (await mine()) {
        schedule.lastError = undefined;
        schedule.slow = false;
        schedule.nextDueAt = started + marketRefreshWait(options.random);
        await recordAttempt(source.id, started);
      }
      void removeOldMarketFiles(source);
      return accepted;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await tidyStore(source.id, started).catch((failure) => console.warn(`[market] Could not tidy the store of ${source.id}:`, failure));
      if (await mine()) {
        schedule.lastError = message;
        schedule.slow = Date.now() - startedAt > (options.readerWaitMs ?? MARKET_READER_WAIT_MS);
        const empty = !await readAcceptedMarket(source).catch(() => null);
        // With nothing in the store the next attempt comes sooner, counted from the end of this one.
        schedule.nextDueAt = empty ? now() + marketRefreshWait(options.random, EMPTY_STORE_RETRY_MS) : started + marketRefreshWait(options.random);
        await recordAttempt(source.id, started, message);
      }
      console.warn(`[market] ${source.id}: refresh failed: ${message}`);
      throw error instanceof Error && error.name === 'MarketRefreshError' ? error : new MarketRefreshError(message);
    }
  })().finally(() => {
    clearTimeout(deadline);
    if (shared.refreshing.get(key) === run) shared.refreshing.delete(key);
  });
  shared.refreshing.set(key, run);
  return run.promise;
}

/** A refresh as a reader gets it: for `waitMs` at most, and never the market of another address than the source's. */
async function forReader(source: MarketSource, refresh: Promise<AcceptedMarket>, waitMs: number): Promise<AcceptedMarket> {
  const accepted = await within(refresh, waitMs, STILL_READING);
  if (!addressBelongs(source, accepted.address)) throw new MarketRefreshError(NOT_THIS_SOURCE);
  return accepted;
}

/**
 * `refreshMarket` for a caller that answers a request: the result when the refresh ends within
 * `MARKET_READER_WAIT_MS`, else a `MarketRefreshError` saying the market is still being read (the refresh goes on).
 */
export function refreshMarketForReader(source: MarketSource, options: MarketStoreOptions = {}): Promise<AcceptedMarket> {
  return forReader(source, refreshMarket(source, options), options.readerWaitMs ?? MARKET_READER_WAIT_MS);
}

/**
 * An explicit "check for updates": the source (every source when none is named) is asked again the next time it is
 * read, and that reader waits for the answer.
 */
export function requestMarketRefresh(sourceId?: string | null, now: number = Date.now()): void {
  if (sourceId) shared.requestedFor.set(scope(sourceId), now);
  else shared.requestedAt = now;
}

async function loadSchedule(source: MarketSource, options: MarketStoreOptions): Promise<SourceSchedule> {
  const now = (options.now ?? Date.now)();
  const schedule = scheduleOf(source.id);
  // The source points at another address than the one last asked: nothing known about the old one counts.
  if (schedule.loaded && schedule.url !== undefined && schedule.url !== source.url) {
    Object.assign(schedule, { lastAttemptAt: 0, nextDueAt: 0, lastError: undefined, slow: false, url: source.url });
  }
  // An attempt in the future (made while the clock was ahead, which has been corrected since) counts as never asked.
  if (schedule.loaded && schedule.lastAttemptAt > now) {
    Object.assign(schedule, { lastAttemptAt: 0, nextDueAt: 0, lastError: undefined, slow: false });
  }
  if (!schedule.loaded) {
    schedule.loaded = true;
    const status = await readMarketRefreshStatus(source.id);
    const checkedAt = status.checked_at ? Date.parse(status.checked_at) : NaN;
    // A time in the future (the clock moved) counts as never asked.
    // The recorded attempt counts only for the address the store holds (a re-pointed source has not been asked yet).
    const record = await readRecord(marketStoreDirectory(source.id)).catch(() => null);
    const sameMarket = !record || addressBelongs(source, record.record.address);
    if (sameMarket && Number.isFinite(checkedAt) && checkedAt <= now) {
      // With nothing in the store, a failed attempt is repeated sooner, as in the process that made it.
      const empty = !await readAcceptedMarket(source).catch(() => null);
      schedule.lastAttemptAt = checkedAt;
      schedule.nextDueAt = checkedAt + marketRefreshWait(options.random, empty ? EMPTY_STORE_RETRY_MS : MARKET_REFRESH_INTERVAL_MS);
      schedule.lastError = status.error;
    }
    schedule.url = source.url;
  }
  return schedule;
}

/**
 * The market of a source for a reader, under the refresh policy:
 *
 * - after `requestMarketRefresh`, the source is asked once and the reader waits (a failure falls back to the store);
 * - with an empty store, the reader waits for the first accept (asked again 30 s after a failure at the earliest);
 * - otherwise the store answers at once, and a refresh starts in the background when the five minutes (plus jitter)
 *   since the last attempt are over.
 *
 * No reader waits longer than `MARKET_READER_WAIT_MS`: after that the store answers (or the reader is told the
 * market is still being read), and the refresh goes on in the background. For an empty store the time counts from
 * the start of the refresh, and a market whose last attempt failed that slowly is read in the background only, so a
 * market that never answers costs the readers of a page one wait, not one per read.
 *
 * Throws `MarketRefreshError` only when there is nothing to read.
 */
export async function currentMarket(source: MarketSource, options: MarketStoreOptions = {}): Promise<AcceptedMarket> {
  const now = (options.now ?? Date.now)();
  const wait = options.readerWaitMs ?? MARKET_READER_WAIT_MS;
  const schedule = await loadSchedule(source, options);
  const accepted = await readAcceptedMarket(source);
  // Only a refresh of this source at this address answers its readers.
  const running = shared.refreshing.get(refreshKey(source));
  const requestedAt = Math.max(shared.requestedAt, shared.requestedFor.get(scope(source.id)) ?? 0);
  const requested = requestedAt > 0 && schedule.lastAttemptAt + EXPLICIT_REFRESH_COALESCE_MS < requestedAt;
  if (requested) {
    try { return await forReader(source, running?.promise ?? refreshMarket(source, options), wait); }
    catch (error) { if (accepted) return accepted; throw error; }
  }
  if (!accepted) {
    if (running) return forReader(source, running.promise, wait - (Date.now() - running.startedAt));
    if (now < schedule.nextDueAt) throw new MarketRefreshError(schedule.lastError ?? 'The market has not been read yet');
    if (schedule.slow) {
      // Its last attempt outlasted the readers' wait and failed: it is read again, but nobody waits for it.
      const last = schedule.lastError;
      void refreshMarket(source, options).catch(() => {});
      throw new MarketRefreshError(last ?? STILL_READING);
    }
    return forReader(source, refreshMarket(source, options), wait);
  }
  if (!running && now >= schedule.nextDueAt) void refreshMarket(source, options).catch(() => {});
  void removeOldMarketFiles(source);
  return accepted;
}

/**
 * Once the official Market's store holds an accepted index, the files of the catalog releases it replaces go: the
 * accepted `catalog.tar` (`market-releases/`) and the cached catalog listing (`catalog-cache.json`).
 */
async function removeOldMarketFiles(source: Pick<MarketSource, 'id' | 'kind' | 'url'>): Promise<void> {
  if (shared.oldFilesRemoved || !isOfficialMarketSource(source)) return;
  try {
    if (!await readAcceptedMarket(source)) return;
    shared.oldFilesRemoved = true;
    for (const name of ['market-releases', 'catalog-cache.json']) {
      const target = path.join(marketStateDir(), name);
      if (await stat(target).then(() => true, () => false)) {
        await rm(target, { recursive: true, force: true });
        console.log(`[market] Removed ${target} (replaced by ${marketStoreDirectory(source.id)})`);
      }
    }
  } catch (error) {
    shared.oldFilesRemoved = false;
    console.warn('[market] Could not remove the old catalog files:', error);
  }
}

/**
 * Remove the stores of sources that no longer exist. A refresh still running for one of them is stopped first: it
 * commits nothing, and what it wrote is gone before its store is.
 */
export async function removeMarketStoresExcept(sourceIds: readonly string[]): Promise<void> {
  const ended = [...shared.refreshing.values()].filter((running) => !sourceIds.includes(running.sourceId));
  for (const running of ended) running.stop.trigger(NOT_THIS_SOURCE);
  await Promise.allSettled(ended.map((running) => within(running.promise, 5_000, NOT_THIS_SOURCE)));
  const root = path.join(marketStateDir(), 'markets');
  const names = await readdir(root).catch(() => [] as string[]);
  for (const name of names) {
    if (!SOURCE_ID.test(name) || sourceIds.includes(name)) continue;
    await rm(path.join(root, name), { recursive: true, force: true }).catch(() => {});
    shared.accepted.delete(scope(name));
    shared.schedule.delete(scope(name));
    shared.requestedFor.delete(scope(name));
  }
}

// ─── What a market says about itself ──────────────────────

/** A market's own words and numbers, for the sources page and for the "add this market?" question. */
export interface MarketSummary {
  address: string;
  /** Self-declared: show as the market's own words. */
  name: string;
  publisher: string;
  homepage?: string;
  commit?: string;
  sequence: number;
  /** `sequence` as a time (it is the commit time); empty when the number is no time. */
  sequence_date: string;
  apps: number;
  /** Apps with setup files (they run inside the app's containers). */
  apps_with_setup: number;
  native: number;
  bundles: number;
}

/** `sequence` (seconds) as an ISO time; '' for a number that is no time, so that showing a market never throws. */
function sequenceDate(sequence: number): string {
  const date = new Date(sequence * 1000);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function summary(address: string, pointer: MarketPointer, index: MarketIndex): MarketSummary {
  return {
    address, name: pointer.name, publisher: pointer.publisher,
    ...(pointer.homepage ? { homepage: pointer.homepage } : {}),
    ...(pointer.commit ? { commit: pointer.commit } : {}),
    sequence: pointer.sequence, sequence_date: sequenceDate(pointer.sequence),
    apps: index.apps.length, apps_with_setup: index.apps.filter((entry) => entry.runs_setup).length,
    // Native apps are YouEye's own: only the official Market's list of them counts (catalog.ts).
    native: isOfficialMarketAddress(address) ? index.native.length : 0, bundles: index.bundles.length,
  };
}

export const acceptedMarketSummary = (accepted: AcceptedMarket): MarketSummary =>
  summary(accepted.address, accepted.pointer, accepted.index);

/**
 * A source as the sources API shows it: its configuration plus what its store holds. Read from disk only. It never
 * throws: a store that cannot be shown is a source without a market and with the reason in `refresh_error`, so one
 * broken store never takes the list (and with it the way to remove that source) away.
 */
export async function marketSourceView(source: MarketSource) {
  let accepted: AcceptedMarket | null = null;
  let market: MarketSummary | null = null;
  let status: MarketRefreshStatus = {};
  let problem: string | undefined;
  try {
    status = await readMarketRefreshStatus(source.id);
    accepted = await readAcceptedMarket(source);
    market = accepted ? acceptedMarketSummary(accepted) : null;
  } catch (error) {
    console.warn(`[market] ${source.id}: this box's copy of the market cannot be shown:`, error);
    accepted = null;
    market = null;
    problem = `This box's copy of the market cannot be read: ${error instanceof Error ? error.message : String(error)}`;
  }
  return {
    ...source,
    /** Where the box's copy of the market was read from (the official Market's follows the box's channel). */
    address: accepted?.address ?? (source.url || null),
    /** The market's own words and state; null while the box has no copy of it. */
    market,
    accepted_market_at: accepted?.acceptedAt ?? null,
    refreshed_at: status.refreshed_at ?? null,
    checked_at: status.checked_at ?? null,
    refresh_error: problem ?? status.error,
  };
}

/**
 * Read the market at `address` (market.json and its index, both checked) without writing anything: what the box
 * shows before the owner adds a market. Throws `MarketRefreshError`: for an address that is not a market, for a
 * market the box would not accept (too large, dated in the future), and for the official lane this box does not
 * follow (`OFFICIAL_MARKET_AS_CUSTOM`, with `code: 'official-market'`; nothing is fetched for it). The lane the box
 * follows is previewed like any market: it is the box's official source already. Neither lane can be added
 * (`withAddedMarketSource`).
 *
 * `native` counts the native apps a source at this address would list: an official lane's, none of any other market.
 * The whole preview takes `MARKET_READER_WAIT_MS` at most.
 */
export async function previewMarket(
  address: string, deps?: MarketFetchDeps, options: Pick<MarketStoreOptions, 'channel' | 'now' | 'readerWaitMs'> = {},
): Promise<MarketSummary> {
  let session: MarketSession | undefined;
  let over = false;
  const reading = (async () => {
    session = await openMarketSession(address, deps);
    if (over) throw new MarketRefreshError(NO_ANSWER_IN_TIME);
    if (isOfficialMarketLane(session.address)) {
      const stored = await readRecord(marketStoreDirectory(OFFICIAL_MARKET_SOURCE_ID)).catch(() => null);
      const own = (await officialMarketAddress(stored?.record.address, options.channel)).address;
      if (session.address !== own) throw new MarketRefreshError(OFFICIAL_MARKET_AS_CUSTOM, 'official-market');
    }
    const answer = await session.get(MARKET_POINTER_FILE, 'pointer');
    if (answer.status !== 'ok') throw new MarketRefreshError(`${MARKET_POINTER_FILE} could not be fetched`);
    const pointer = readMarketPointer(answer.bytes);
    const fromTheFuture = futureSequenceProblem(pointer.sequence, (options.now ?? Date.now)());
    if (fromTheFuture) throw new MarketRefreshError(fromTheFuture);
    const index = readMarketIndex(await fetchHashed(session, pointer.index, 'index', 'The index'));
    const tooLarge = indexLimitProblem(index);
    if (tooLarge) throw new MarketRefreshError(`This market is too large: ${tooLarge}`);
    return summary(session.address, pointer, index);
  })();
  try {
    // A preview answers a request: like a reader, it does not wait for a market longer than that.
    return await within(reading, options.readerWaitMs ?? MARKET_READER_WAIT_MS, NO_ANSWER_IN_TIME);
  } catch (error) {
    // A market that cannot be read is a refusal whatever went wrong (nothing of this box is involved in a preview).
    throw error instanceof Error && error.name === 'MarketRefreshError' ? error : new MarketRefreshError(error instanceof Error ? error.message : String(error));
  } finally {
    over = true;
    session?.close();
  }
}

// ─── Pictures ─────────────────────────────────────────────

/**
 * A place among the pictures being fetched from markets (`PICTURE_FETCH_LIMITS`), for one picture of `sourceKey`.
 * Resolves to the function that gives the place back. A request that finds none waits its turn, `waitMs` at most;
 * then, or when too many wait already, it fails with `MarketBusyError`.
 */
function pictureFetchPlace(sourceKey: string, waitMs: number): Promise<() => void> {
  const pool = shared.pictureFetches;
  const free = (key: string) => pool.all < PICTURE_FETCH_LIMITS.all && (pool.bySource.get(key) ?? 0) < PICTURE_FETCH_LIMITS.perSource;
  const take = (key: string) => {
    pool.all += 1;
    pool.bySource.set(key, (pool.bySource.get(key) ?? 0) + 1);
    let returned = false;
    return () => {
      if (returned) return;
      returned = true;
      pool.all -= 1;
      const left = (pool.bySource.get(key) ?? 1) - 1;
      if (left > 0) pool.bySource.set(key, left); else pool.bySource.delete(key);
      // The longest waiter whose market has a place left goes next.
      const next = pool.waiting.findIndex((waiter) => free(waiter.sourceKey));
      if (next >= 0) pool.waiting.splice(next, 1)[0].grant();
    };
  };
  if (free(sourceKey)) return Promise.resolve(take(sourceKey));
  if (pool.waiting.length >= PICTURE_QUEUE_LENGTH || !(waitMs > 0)) return Promise.reject(new MarketBusyError());
  return new Promise((resolve, reject) => {
    const waiter: PictureWaiter = {
      sourceKey,
      grant: () => { clearTimeout(timer); resolve(take(sourceKey)); },
    };
    const timer = setTimeout(() => {
      const position = pool.waiting.indexOf(waiter);
      if (position >= 0) pool.waiting.splice(position, 1);
      reject(new MarketBusyError());
    }, waitMs);
    pool.waiting.push(waiter);
  });
}

async function pictureBytesStored(directory: string): Promise<number> {
  const names = await readdir(path.join(directory, 'h', 'files')).catch(() => [] as string[]);
  let total = 0;
  for (const name of names) total += (await stat(path.join(directory, 'h', 'files', name)).catch(() => null))?.size ?? 0;
  return total;
}

/**
 * A picture of a source's accepted market: from the store, or fetched on first use (5 MiB limit, checked against the
 * hash in its path, one fetch shared by simultaneous callers) and then kept in the store.
 *
 * Null, without any request, unless `file` is a picture path that the accepted index or a stored bundle names.
 * Throws when the picture is named but cannot be fetched; the failure is remembered for a minute. At most
 * `PICTURE_FETCH_LIMITS` pictures are fetched at a time; a request that finds no place in time throws
 * `MarketBusyError`, which is not a failure of the picture and is not remembered.
 */
export async function readMarketPicture(
  source: Pick<MarketSource, 'id' | 'kind' | 'url'>, file: string, options: MarketStoreOptions = {},
): Promise<{ bytes: Buffer; contentType: string } | null> {
  const named = fileHashOf(file);
  if (!named) return null;
  const accepted = await readAcceptedMarket(source);
  if (!accepted || !accepted.pictures.has(file)) return null;
  const directory = marketStoreDirectory(source.id);
  const target = path.join(directory, file);
  const stored = await readOptional(target, MARKET_LIMITS.file);
  if (stored && sha256Hex(stored) === named.sha256) return { bytes: stored, contentType: named.contentType };

  const now = (options.now ?? Date.now)();
  const key = `${scope(source.id)}${file}`;
  const failed = shared.pictureFailures.get(key);
  if (failed && now < failed.until) throw new MarketRefreshError(failed.message);
  let fetching = shared.pictures.get(key);
  if (!fetching) {
    fetching = (async () => {
      const giveBack = await pictureFetchPlace(scope(source.id), options.pictureWaitMs ?? PICTURE_QUEUE_WAIT_MS);
      try {
        const session = await openMarketSession(accepted.address, options.deps);
        try {
          const answer = await session.get(file, 'file');
          if (answer.status !== 'ok' || sha256Hex(answer.bytes) !== named.sha256) {
            throw new MarketRefreshError(`The picture is not the file its hash names (${file})`);
          }
          if (await pictureBytesStored(directory) + answer.bytes.byteLength <= MARKET_STORE_LIMITS.pictureBytes) {
            await writeAtomically(target, answer.bytes).catch((error) => console.warn(`[market] Could not keep ${file} of ${source.id}:`, error));
          }
          return answer.bytes;
        } finally {
          session.close();
        }
      } finally {
        giveBack();
      }
    })().catch((error) => {
      // No place in time says nothing about the picture: the next request tries again.
      if (error instanceof Error && error.name === 'MarketBusyError') throw error;
      const message = error instanceof Error ? error.message : String(error);
      shared.pictureFailures.set(key, { until: now + PICTURE_FAILURE_MEMORY_MS, message });
      throw new MarketRefreshError(message);
    }).finally(() => { shared.pictures.delete(key); });
    shared.pictures.set(key, fetching);
  }
  return { bytes: await fetching, contentType: named.contentType };
}

/**
 * The icon picture of an app being installed from `sourceId`, for the dashboard. Only a source that may be installed
 * from (enabled; a custom market accepted) answers, and only with a picture its accepted market names.
 */
export async function readInstallIconPicture(sourceId: string, file: string, options: MarketStoreOptions = {}): Promise<Buffer | null> {
  const source = (await getConfiguredMarketSources()).find((candidate) => candidate.id === sourceId);
  if (!source || marketSourceRefusal(source)) return null;
  return (await readMarketPicture(source, file, options))?.bytes ?? null;
}
