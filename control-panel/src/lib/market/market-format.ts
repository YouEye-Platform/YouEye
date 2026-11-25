/**
 * The published Market format, `youeye.market.v1` (docs/market-format.md).
 *
 * A market is a folder of static files at an HTTPS address. Its address is the folder's URL
 * with the trailing slash, and every path in every file is relative to that folder:
 *
 *   market.json                   the only file that changes: names the index by SHA-256
 *   h/index/<sha256>.json         the catalog at one commit
 *   h/apps/<id>/<sha256>.json     one app: its manifest and setup files
 *   h/files/<sha256>.<ext>        icons and screenshots
 *
 * The generator (scripts/market-build.ts) writes these; the box's reader accepts them. Both
 * use this module, so they cannot drift apart. Rules that keep old boxes working:
 *
 * - Readers ignore fields they do not know. `market.json` and the index may only grow.
 * - An index entry the reader cannot use (unknown `kind`, `requires.youeye` above the box) is
 *   listed as "needs a newer YouEye", never dropped. An entry that is not even an entry is
 *   skipped with a warning and never sinks the index.
 * - Every file is checked against the hash that pointed to it. A hashed path carries the hash
 *   it must have, so a path can never point at other content.
 *
 * This module imports nothing from the box (no store, no Spine client): the generator runs it
 * outside the Control Panel.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod/v4';

export const MARKET_SCHEMA = 'youeye.market.v1';
export const MARKET_INDEX_SCHEMA = 'youeye.market-index.v1';
export const MARKET_POINTER_FILE = 'market.json';

/** Size limits in bytes. A reader refuses a larger file before parsing it. */
export const MARKET_LIMITS = {
  pointer: 64 * 1024,
  index: 4 * 1024 * 1024,
  bundle: 1024 * 1024,
  file: 5 * 1024 * 1024,
} as const;

/**
 * The app kinds this reader installs: `container` (OCI images pinned by digest) and, from 0.6.20, `native` (a
 * Node.js app whose `standalone.tar` the manifest pins by `source.package`). Any other kind is "needs a newer YouEye";
 * so is `native` on boxes before 0.6.20, which is why every native entry also says `requires.youeye: ">=0.6.20"`.
 */
export const MARKET_APP_KINDS = ['container', 'native'] as const;

export const MARKET_IMAGE_TYPES: Record<string, string> = {
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

/** The largest `sequence` a pointer may carry: 2100-01-01T00:00:00Z in seconds. */
export const MARKET_SEQUENCE_MAX = 4_102_444_800;

const SHA256 = /^[0-9a-f]{64}$/;
const APP_ID = /^[a-z][a-z0-9-]{0,31}$/;
const INDEX_PATH = /^h\/index\/([0-9a-f]{64})\.json$/;
const BUNDLE_PATH = /^h\/apps\/([a-z][a-z0-9-]{0,31})\/([0-9a-f]{64})\.json$/;
const FILE_PATH = /^h\/files\/([0-9a-f]{64})\.(svg|png|jpg|jpeg|webp|gif)$/;

export const sha256Hex = (bytes: Uint8Array | string): string =>
  createHash('sha256').update(bytes).digest('hex');

// ─── Paths ────────────────────────────────────────────────

export const indexPath = (sha256: string) => `h/index/${sha256}.json`;
export const bundlePath = (appId: string, sha256: string) => `h/apps/${appId}/${sha256}.json`;
export const filePath = (sha256: string, extension: string) => `h/files/${sha256}.${extension.toLowerCase()}`;

/** The hash a picture path promises, or null when the path is not a picture path. */
export function fileHashOf(path: string): { sha256: string; extension: string; contentType: string } | null {
  const match = FILE_PATH.exec(path);
  return match ? { sha256: match[1], extension: match[2], contentType: MARKET_IMAGE_TYPES[match[2]] } : null;
}

const FileRef = z.string().refine((value) => FILE_PATH.test(value), 'must be h/files/<sha256>.<svg|png|jpg|jpeg|webp|gif>');

/** A hashed JSON file: the path must carry the same hash as `sha256`. */
function hashedRef(pattern: RegExp, hashGroup: number, what: string) {
  return z.object({
    path: z.string(),
    sha256: z.string().regex(SHA256),
    size: z.number().int().positive(),
  }).superRefine((value, ctx) => {
    const match = pattern.exec(value.path);
    if (!match) ctx.addIssue({ code: 'custom', path: ['path'], message: `must be ${what}` });
    else if (match[hashGroup] !== value.sha256) ctx.addIssue({ code: 'custom', path: ['path'], message: 'path and sha256 differ' });
  });
}

// ─── market.json ──────────────────────────────────────────

const ShortText = z.string().min(1).max(120);

/** Unknown fields are dropped (z.object strips them): the pointer may grow. */
export const MarketPointerSchema = z.object({
  schema: z.literal(MARKET_SCHEMA),
  /** What the market calls itself. Shown as the market's own words, never trusted. */
  name: ShortText,
  publisher: ShortText,
  homepage: z.string().max(300).optional(),
  /**
   * Commit time in seconds since the epoch, at most `MARKET_SEQUENCE_MAX`. A box never accepts a lower one for the
   * same market address, so a value that is no time (milliseconds, a counter gone wrong) is refused here.
   */
  sequence: z.number().int().positive().max(MARKET_SEQUENCE_MAX, `must be a time in seconds, at most ${MARKET_SEQUENCE_MAX} (the year 2100)`),
  commit: z.string().max(64).optional(),
  index: hashedRef(INDEX_PATH, 1, 'h/index/<sha256>.json').refine(
    (value) => value.size <= MARKET_LIMITS.index, 'index is larger than the limit'),
});
export type MarketPointer = z.infer<typeof MarketPointerSchema>;

// ─── The index ────────────────────────────────────────────

/**
 * What a reader needs to list an app without its bundle. Only `id`, `kind` and `name` are
 * required, so an entry of a kind this reader does not know still parses and is listed as
 * "needs a newer YouEye".
 */
export const MarketIndexEntrySchema = z.object({
  id: z.string().regex(APP_ID),
  kind: z.string().min(1).max(40),
  name: ShortText,
  version: z.string().max(80).optional(),
  tagline: z.string().max(300).optional(),
  description: z.string().max(2000).optional(),
  category: z.string().max(40).optional(),
  tags: z.array(z.string().max(40)).max(40).optional(),
  developer: z.string().max(200).optional(),
  icon: FileRef.optional(),
  /** `>=X.Y.Z`. Read here, so a box that is too old never has to parse the manifest. */
  requires: z.object({ youeye: z.string().regex(/^>=\d+\.\d+\.\d+$/) }).optional(),
  /** True when the app has setup files (they run inside its containers). */
  runs_setup: z.boolean().optional(),
  bundle: hashedRef(BUNDLE_PATH, 2, 'h/apps/<id>/<sha256>.json').refine(
    (value) => value.size <= MARKET_LIMITS.bundle, 'bundle is larger than the limit').optional(),
}).superRefine((value, ctx) => {
  if (value.bundle && BUNDLE_PATH.exec(value.bundle.path)?.[1] !== value.id) {
    ctx.addIssue({ code: 'custom', path: ['bundle', 'path'], message: 'bundle path is for another app' });
  }
});
export type MarketIndexEntry = z.infer<typeof MarketIndexEntrySchema>;

const Category = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,40}$/),
  label: ShortText,
  icon: z.string().optional(),
  order: z.number().optional(),
  tile: z.object({ bg: z.string(), fg: z.string() }).optional(),
});

const Curation = z.object({
  spotlight: z.object({ title: z.string().optional(), apps: z.array(z.string()) }).optional(),
  collections: z.array(z.object({ id: z.string(), label: z.string(), apps: z.array(z.string()) })).optional(),
});

/**
 * `apps` and `bundles` are read entry by entry (`readMarketIndex`): one entry this reader
 * cannot parse must not take the others with it. (Indexes before 0.6.20 also carried `native`, the ids of native
 * apps of the box's channel; native apps are `apps` entries of kind `native` now, and the key is ignored.)
 */
export const MarketIndexSchema = z.object({
  schema: z.literal(MARKET_INDEX_SCHEMA),
  categories: z.array(Category).optional(),
  curation: Curation.optional(),
  /** Each is the text of a `bundles/<id>/bundle.yaml`; the reader parses it with the bundle parser. */
  bundles: z.array(z.unknown()).optional(),
  apps: z.array(z.unknown()),
});

export const MarketIndexBundleSchema = z.object({
  id: z.string().regex(APP_ID),
  definition: z.string().max(64 * 1024),
});

export interface MarketIndex {
  categories: z.infer<typeof Category>[];
  curation?: z.infer<typeof Curation>;
  bundles: z.infer<typeof MarketIndexBundleSchema>[];
  apps: MarketIndexEntry[];
  /** One line per entry that was skipped, for the log and the sources page. */
  warnings: string[];
}

function issues(error: z.ZodError): string {
  return error.issues.slice(0, 3).map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
}

function parseJSON(bytes: Uint8Array | string, limit: number, what: string): unknown {
  const size = typeof bytes === 'string' ? Buffer.byteLength(bytes, 'utf8') : bytes.byteLength;
  if (size > limit) throw new Error(`${what} is ${size} bytes, more than the ${limit} allowed`);
  const text = typeof bytes === 'string' ? bytes : Buffer.from(bytes).toString('utf8');
  try { return JSON.parse(text); } catch { throw new Error(`${what} is not JSON`); }
}

/** Parse `market.json`. Throws with a short reason when it is not a pointer this reader accepts. */
export function readMarketPointer(bytes: Uint8Array | string): MarketPointer {
  const parsed = MarketPointerSchema.safeParse(parseJSON(bytes, MARKET_LIMITS.pointer, MARKET_POINTER_FILE));
  if (!parsed.success) throw new Error(`${MARKET_POINTER_FILE}: ${issues(parsed.error)}`);
  return parsed.data;
}

/**
 * Parse an index whose bytes the caller has already checked against the pointer's hash.
 * Entries that do not parse are skipped and named in `warnings`; duplicate ids keep the first.
 */
export function readMarketIndex(bytes: Uint8Array | string): MarketIndex {
  const parsed = MarketIndexSchema.safeParse(parseJSON(bytes, MARKET_LIMITS.index, 'the index'));
  if (!parsed.success) throw new Error(`the index: ${issues(parsed.error)}`);
  const warnings: string[] = [];
  const apps: MarketIndexEntry[] = [];
  const seen = new Set<string>();
  for (const [position, raw] of parsed.data.apps.entries()) {
    const entry = MarketIndexEntrySchema.safeParse(raw);
    const id = typeof (raw as { id?: unknown })?.id === 'string' ? (raw as { id: string }).id : `#${position}`;
    if (!entry.success) { warnings.push(`app ${id}: ${issues(entry.error)}`); continue; }
    if (seen.has(entry.data.id)) { warnings.push(`app ${id}: listed twice`); continue; }
    seen.add(entry.data.id);
    apps.push(entry.data);
  }
  const bundles: MarketIndex['bundles'] = [];
  for (const [position, raw] of (parsed.data.bundles ?? []).entries()) {
    const bundle = MarketIndexBundleSchema.safeParse(raw);
    if (!bundle.success) { warnings.push(`bundle #${position}: ${issues(bundle.error)}`); continue; }
    bundles.push(bundle.data);
  }
  return {
    categories: parsed.data.categories ?? [],
    curation: parsed.data.curation,
    bundles,
    apps,
    warnings,
  };
}

// ─── App bundles ──────────────────────────────────────────

/**
 * One app. `manifest` is the text of its `youeye-app.yaml`, `setups` the text of each file
 * under `setup/` by file name, `files` maps the picture paths the manifest names (`icon.svg`,
 * `screenshots/a.webp`) to their hashed paths.
 */
export const MarketAppBundleSchema = z.object({
  manifest: z.string().min(1),
  setups: z.record(z.string(), z.string()).optional(),
  files: z.record(z.string(), FileRef).optional(),
});
export type MarketAppBundle = z.infer<typeof MarketAppBundleSchema>;

/** Parse a bundle whose bytes the caller has already checked against the index entry's hash. */
export function readMarketAppBundle(bytes: Uint8Array | string): MarketAppBundle {
  const parsed = MarketAppBundleSchema.safeParse(parseJSON(bytes, MARKET_LIMITS.bundle, 'the app bundle'));
  if (!parsed.success) throw new Error(`the app bundle: ${issues(parsed.error)}`);
  return parsed.data;
}

// ─── Addresses ────────────────────────────────────────────

/**
 * A market's address: an HTTPS folder URL with the trailing slash, no credentials, query or
 * fragment. `https://example.org/market` becomes `https://example.org/market/`; a `market.json`
 * URL becomes its folder. Throws when the input cannot be a market address.
 */
export function normalizeMarketAddress(input: string): string {
  let url: URL;
  try { url = new URL(input.trim()); } catch { throw new Error('A market address must be a URL'); }
  if (url.protocol !== 'https:') throw new Error('A market address must start with https://');
  if (url.username || url.password) throw new Error('A market address must not contain credentials');
  if (url.search || url.hash) throw new Error('A market address must not contain a query or a fragment');
  let path = url.pathname;
  if (path.endsWith(`/${MARKET_POINTER_FILE}`)) path = path.slice(0, -MARKET_POINTER_FILE.length);
  if (!path.endsWith('/')) path += '/';
  if (path.split('/').some((part) => part === '..' || part === '.')) throw new Error('A market address must not contain dot segments');
  return `${url.protocol}//${url.host.toLowerCase()}${path}`;
}

/** The URL of a market file. `path` is `market.json` or a hashed path; anything else throws. */
export function marketFileURL(address: string, path: string): string {
  if (path !== MARKET_POINTER_FILE && !INDEX_PATH.test(path) && !BUNDLE_PATH.test(path) && !FILE_PATH.test(path)) {
    throw new Error(`Not a market file path: ${path}`);
  }
  return address + path;
}

/** `X.Y.Z` of a `>=X.Y.Z` requirement, or null. */
export function requiredYouEye(entry: Pick<MarketIndexEntry, 'requires'>): string | null {
  return entry.requires ? entry.requires.youeye.slice(2) : null;
}

export const isKnownAppKind = (kind: string): boolean => (MARKET_APP_KINDS as readonly string[]).includes(kind);
