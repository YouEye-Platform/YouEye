/**
 * Build a market (`youeye.market.v1`, src/lib/market/market-format.ts) from a Market catalog
 * repository: a folder of static files that any HTTPS host can serve.
 *
 *   node --import tsx scripts/market-build.ts <market-repo-dir> --out <dir> [--commit <sha>] [--sequence <unix seconds>]
 *     [--official | --address <https address of this market>] [--native-listing <file.json>] [--require-provenance]
 *
 * Run it from control-panel/ (tsx and the `@/` paths resolve there). The repository may be a git
 * checkout or a plain export (`git archive`); without `.git`, --commit and --sequence are required.
 * The sequence (given or the commit time) must be plausible Unix seconds (at most the year 2100) and
 * at most 300 seconds ahead of this machine's clock: a box never accepts a lower sequence after a
 * higher one, so a sequence from the future would hold back every later build.
 * `<dir>` must be missing or empty.
 *
 * Output (every path relative to `<dir>`, as the format defines):
 *   market.json                 schema, name, publisher, homepage, sequence, commit, index {path, sha256, size}
 *   h/index/<sha256>.json       categories, curation, native, bundles, apps (one entry per app)
 *   h/apps/<id>/<sha256>.json   { manifest, setups, files } of one app
 *   h/files/<sha256>.<ext>      icons and screenshots the listings name (identical pictures once)
 *   notices/<id>/<file>         licence and notice files of an app folder (bytes unchanged)
 *   notices/<file>              licence and notice files at the repository root (bytes unchanged)
 *                               Published as text only: see `noticeOutputName` (a name without
 *                               .txt or .md gets .txt, anything else is refused), at most 1 MiB each.
 *   index.html, apps/<id>/, make-your-own-market/, notices/index.html, site.css, site.js, fonts/
 *                               the website (scripts/market-site.ts)
 *
 * The website's "Add to YouEye" buttons: with --official, each app page links
 * https://my.youeye.me/app?id=<id>; with --address (another market), the pages link
 * https://my.youeye.me/add?market=<address>; with neither, there is no button. --native-listing
 * names a JSON file `{ "<id>": { "name", "tagline", "description", "version" } }` with the listing
 * text of native apps (catalog.yaml names only their ids); without it they are listed by name.
 * --require-provenance (the publish tool passes it for the official lanes) refuses a repository
 * without asset-provenance.json; without it the file is checked only when it exists.
 *
 * Nothing is written until every app, bundle, picture and limit is valid; every error is printed.
 * The output depends only on the repository files, --commit and --sequence: JSON is written
 * compactly with a trailing newline, keys in a fixed order, lists sorted, no times or host paths.
 * The last step reads everything back with the format's own readers.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileApp } from '../src/lib/market/app-format/compile';
import { AppFormatError, parseAppSource, parseBundle, parseCatalog, readYAML } from '../src/lib/market/app-format/parse';
import { OLDEST_MARKET_READER, requiresProblems } from '../src/lib/market/app-format/since';
import {
  MARKET_INDEX_SCHEMA, MARKET_IMAGE_TYPES, MARKET_LIMITS, MARKET_POINTER_FILE, MARKET_SCHEMA, MARKET_SEQUENCE_MAX, MarketIndexBundleSchema,
  MarketIndexEntrySchema, MarketPointerSchema, bundlePath, fileHashOf, filePath, indexPath, readMarketAppBundle,
  readMarketIndex, readMarketPointer, sha256Hex,
  normalizeMarketAddress,
} from '../src/lib/market/market-format';
import { buildSite, nameFromId, readNativeListing, type SiteApp, type SiteOptions } from './market-site';

const APP_ID = /^[a-z][a-z0-9-]{0,31}$/;
/** A file name that is meant as a licence or notice file (carried to `notices/`, or refused when it cannot be). */
const NOTICE_FILE = /^(?:LICEN[CS]E|COPYING|NOTICES?|ASSET-NOTICES)(?:$|[._-])/i;
/** stem, `-word` qualifiers, at most one `.word` qualifier, then an optional .txt or .md. */
const NOTICE_NAME = /^((?:LICEN[CS]E|COPYING|NOTICES?|ASSET-NOTICES)(?:[_-][A-Za-z0-9]+)*)(?:\.([A-Za-z0-9][A-Za-z0-9-]*))?(?:\.(txt|md))?$/i;
/** A `.word` qualifier that names a licence (`COPYING.GPLv2`), allowed without .txt or .md. */
const LICENCE_QUALIFIER = /^(?:(?:A|L)?GPL|MPL|EPL|EUPL|CDDL|Apache|BSD|MIT|ISC|OFL|CC-)[A-Za-z0-9-]*$/i;
/** The largest licence or notice file published. */
export const MAX_NOTICE_BYTES = 1024 * 1024;
/** How far the sequence may be ahead of this machine's clock, in seconds. */
export const SEQUENCE_CLOCK_SKEW = 300;
const PROVENANCE_FILE = 'asset-provenance.json';
const PROVENANCE_API_VERSION = 'youeye.market/asset-provenance/v1';
const PROVENANCE_EVIDENCE = ['exact-source', 'project-reference', 'local-capture'];

export class MarketBuildError extends Error {
  readonly errors: string[];
  constructor(errors: string[]) {
    super(errors.join('\n'));
    this.name = 'MarketBuildError';
    this.errors = errors;
  }
}

export interface BuildOptions {
  commit: string;
  /** Commit time in Unix seconds. */
  sequence: number;
  /** This machine's clock in Unix seconds (tests); the real clock by default. */
  now?: number;
  /** Refuse a repository without asset-provenance.json (the official lanes). */
  requireProvenance?: boolean;
  /** The website's buttons and native app listings (scripts/market-site.ts). */
  site?: SiteOptions;
}

export interface MarketSummary {
  apps: number;
  bundles: number;
  native: number;
  pictures: number;
  notices: number;
  files: number;
  /** HTML pages of the website. */
  pages: number;
  bytes: { pointer: number; index: number; bundles: number; pictures: number; notices: number; site: number };
}

export interface BuiltMarket {
  /** Every output file by its path under the market folder. */
  files: Map<string, Buffer>;
  summary: MarketSummary;
}

const byPath = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const json = (value: unknown) => Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const sortedRecord = <T>(entries: Iterable<[string, T]>): Record<string, T> =>
  Object.fromEntries([...entries].sort(([a], [b]) => byPath(a, b)));

/**
 * Every file under `root`, relative, sorted; dot files, `.git` and `node_modules` are skipped.
 * Symbolic links are returned separately (they are refused: a link could reach outside the repository).
 */
export function listFiles(root: string): { files: string[]; links: string[] } {
  const files: string[] = [];
  const links: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(path.join(root, dir))) {
      if (name.startsWith('.') || name === 'node_modules') continue;
      const rel = dir ? `${dir}/${name}` : name;
      const info = lstatSync(path.join(root, rel));
      if (info.isSymbolicLink()) links.push(rel);
      else if (info.isDirectory()) walk(rel);
      else if (info.isFile()) files.push(rel);
    }
  };
  walk('');
  return { files: files.sort(byPath), links: links.sort(byPath) };
}

/** First-level folder names under `area/` that hold at least one file. */
function folders(files: string[], area: string): string[] {
  const names = new Set<string>();
  for (const file of files) {
    const parts = file.split('/');
    if (parts[0] === area && parts.length > 2) names.add(parts[1]);
  }
  return [...names].sort(byPath);
}

interface Picture { sha256: string; extension: string; bytes: Buffer }

function isHttpsURL(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch { return false; }
}

/**
 * The name a licence or notice file is published under, so that any host serves it as text: a name that ends in .txt
 * or .md is kept, a name without a type (`LICENSE`, `COPYING.GPLv2`) gets `.txt`. Null for a name that is not a notice
 * name; an error for a notice name of another type (`LICENSE.html`, `NOTICE.svg`), which would be active content on
 * the market's origin.
 */
export function noticeOutputName(name: string): string | null | { error: string } {
  if (!NOTICE_FILE.test(name)) return null;
  const match = NOTICE_NAME.exec(name);
  const [, , qualifier, type] = match ?? [];
  const typed = type ?? (qualifier && /^(?:txt|md)$/i.test(qualifier) ? qualifier : undefined);
  if (match && (typed || !qualifier || LICENCE_QUALIFIER.test(qualifier))) return typed ? name : `${name}.txt`;
  return { error: 'a licence or notice file is published as text: name it like LICENSE, LICENSE.txt, LICENSE.md, '
    + 'LICENSE-<words>.txt or COPYING.<licence> (letters, digits and dashes)' };
}

/**
 * When the repository has an asset-provenance.json (the official catalog does), every picture
 * under apps/ needs exactly one current record in it. A market without that file is not checked,
 * unless `required` (--require-provenance, the official lanes): then it is refused.
 */
function provenanceErrors(root: string, files: string[], required: boolean): string[] {
  if (!files.includes(PROVENANCE_FILE)) {
    return required ? [`${PROVENANCE_FILE}: missing (--require-provenance: every picture needs a provenance record)`] : [];
  }
  const pictures = files.filter((file) => file.startsWith('apps/')
    && Object.hasOwn(MARKET_IMAGE_TYPES, path.extname(file).slice(1).toLowerCase()));
  let document: { apiVersion?: unknown; assets?: unknown };
  try { document = JSON.parse(readFileSync(path.join(root, PROVENANCE_FILE), 'utf8')); }
  catch { return [`${PROVENANCE_FILE}: not JSON`]; }
  if (document?.apiVersion !== PROVENANCE_API_VERSION || !Array.isArray(document.assets)) {
    return [`${PROVENANCE_FILE}: apiVersion must be ${PROVENANCE_API_VERSION} and assets a list`];
  }
  const errors: string[] = [];
  const expected = new Map(pictures.map((file) => [file, `sha256:${sha256Hex(readFileSync(path.join(root, file)))}`]));
  const seen = new Set<string>();
  for (const [index, record] of (document.assets as Array<Record<string, unknown>>).entries()) {
    const where = typeof record?.path === 'string' ? record.path : `assets[${index}]`;
    if (typeof record?.path !== 'string' || !expected.has(record.path)) {
      errors.push(`${PROVENANCE_FILE}: ${where}: no such picture under apps/`);
      continue;
    }
    if (seen.has(record.path)) errors.push(`${PROVENANCE_FILE}: ${where}: listed twice`);
    seen.add(record.path);
    if (record.sha256 !== expected.get(record.path)) errors.push(`${PROVENANCE_FILE}: ${where}: sha256 is stale (the file is ${expected.get(record.path)})`);
    if (!PROVENANCE_EVIDENCE.includes(record.evidence as string)) {
      errors.push(`${PROVENANCE_FILE}: ${where}: evidence must be one of ${PROVENANCE_EVIDENCE.join(', ')}`);
    }
    if (!isHttpsURL(record.source)) errors.push(`${PROVENANCE_FILE}: ${where}: source must be an https URL without credentials`);
    if (typeof record.notes !== 'string' || !record.notes.trim()) errors.push(`${PROVENANCE_FILE}: ${where}: notes are required`);
  }
  for (const file of expected.keys()) if (!seen.has(file)) errors.push(`${file}: picture has no record in ${PROVENANCE_FILE}`);
  return errors;
}

/** Validate the repository and build every output file in memory. Throws MarketBuildError with every problem. */
export function buildMarket(root: string, options: BuildOptions): BuiltMarket {
  const errors: string[] = [];
  const { files, links } = listFiles(root);
  for (const link of links) if (/^(apps|bundles)\//.test(link) || !link.includes('/')) errors.push(`${link}: symbolic links are not allowed`);
  const has = new Set(files);
  const read = (file: string) => readFileSync(path.join(root, file));
  const text = (file: string) => read(file).toString('utf8');

  if (!/^\S{1,64}$/.test(options.commit)) errors.push('--commit must be 1–64 characters without spaces');
  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(options.sequence) || options.sequence <= 0 || options.sequence > MARKET_SEQUENCE_MAX) {
    errors.push(`--sequence must be Unix seconds: a positive whole number up to ${MARKET_SEQUENCE_MAX} (the year 2100), got ${options.sequence}`);
  } else if (options.sequence > now + SEQUENCE_CLOCK_SKEW) {
    errors.push(`--sequence ${options.sequence} is ${options.sequence - now} seconds ahead of this machine's clock (at most ${SEQUENCE_CLOCK_SKEW}): `
      + 'check the commit time and the clock (a box would refuse every later build with a lower sequence)');
  }
  let address: string | undefined;
  if (options.site?.address !== undefined) {
    try {
      address = normalizeMarketAddress(options.site.address);
      if (address.length > 1500) errors.push('--address is longer than 1,500 characters');
    } catch (error) { errors.push(`--address: ${message(error)}`); }
  }

  // store.yaml: what the market calls itself.
  let store: { name?: unknown; publisher?: unknown; homepage?: unknown } = {};
  if (!has.has('store.yaml')) errors.push('store.yaml: missing (it names the market and its publisher)');
  else {
    try { store = (readYAML(text('store.yaml'), 'store.yaml') ?? {}) as typeof store; } catch (error) { errors.push(message(error)); }
    for (const key of ['name', 'publisher'] as const) {
      if (typeof store[key] !== 'string' || !store[key] || (store[key] as string).length > 120) errors.push(`store.yaml: ${key} must be text of 1–120 characters`);
    }
    if (store.homepage !== undefined && (!isHttpsURL(store.homepage) || (store.homepage as string).length > 300)) {
      errors.push('store.yaml: homepage must be an https URL');
    }
  }

  // catalog.yaml: categories, curation, native ids.
  let catalog: ReturnType<typeof parseCatalog> | null = null;
  if (!has.has('catalog.yaml')) errors.push('catalog.yaml: missing');
  else {
    try { catalog = parseCatalog(text('catalog.yaml')); } catch (error) { errors.push(message(error)); }
  }
  const native = catalog?.native ?? [];
  const appIds = folders(files, 'apps');
  const known = new Set([...appIds, ...native]);
  const categories = new Set((catalog?.categories ?? []).map((category) => category.id));
  for (const id of native) if (appIds.includes(id)) errors.push(`catalog.yaml: native app "${id}" also has an app folder`);
  if (new Set(native).size !== native.length) errors.push('catalog.yaml: native lists an id twice');
  for (const [where, ids] of [
    ['curation.spotlight', catalog?.curation?.spotlight?.apps ?? []],
    ...(catalog?.curation?.collections ?? []).map((collection) => [`curation.collections.${collection.id}`, collection.apps] as const),
  ] as const) {
    for (const id of ids) if (!known.has(id)) errors.push(`catalog.yaml: ${where} names "${id}", which is not in the catalog`);
  }

  // Apps.
  const pictures = new Map<string, Picture>();
  const prepared: Array<{ id: string; manifest: string; setups: Record<string, string>; files: Record<string, string>;
    entry: Record<string, unknown>; site: SiteApp }> = [];
  for (const id of appIds) {
    const where = `apps/${id}`;
    if (!APP_ID.test(id)) { errors.push(`${where}: the folder name is not an app id ([a-z][a-z0-9-], at most 32)`); continue; }
    if (!has.has(`${where}/youeye-app.yaml`)) { errors.push(`${where}: missing youeye-app.yaml`); continue; }
    const manifest = text(`${where}/youeye-app.yaml`);
    // Every file under setup/ is passed, so a file the app does not name is refused.
    const setups = sortedRecord(files.filter((file) => file.startsWith(`${where}/setup/`))
      .map((file) => [file.slice(where.length + 1), text(file)] as [string, string]));
    let parsed: ReturnType<typeof parseAppSource>;
    try {
      parsed = parseAppSource({ manifest, setups });
      compileApp(parsed);
    } catch (error) {
      const issues = error instanceof AppFormatError ? error.issues : [message(error)];
      for (const issue of issues) errors.push(`${where}: ${error instanceof AppFormatError ? `${error.message.split(':')[0]}: ` : ''}${issue}`);
      continue;
    }
    const app = parsed.app;
    const problems: string[] = [];
    if (app.id !== id) problems.push(`id is "${app.id}"; it must equal the folder name`);
    if (!app.image) problems.push('a Market app is a container app (image:); native apps are named in catalog.yaml native');
    problems.push(...requiresProblems(parsed, OLDEST_MARKET_READER));
    const listing = app.listing ?? {};
    if (categories.size && listing.category && !categories.has(listing.category)) {
      problems.push(`listing.category "${listing.category}" is not a category of catalog.yaml`);
    }
    const named = [listing.icon_file, ...(listing.screenshots ?? []).map((shot) => shot.path)].filter((file): file is string => Boolean(file));
    const fileMap: Array<[string, string]> = [];
    for (const name of [...new Set(named)]) {
      const file = `${where}/${name}`;
      const extension = path.extname(name).slice(1).toLowerCase();
      if (!Object.hasOwn(MARKET_IMAGE_TYPES, extension)) { problems.push(`${name}: pictures are ${Object.keys(MARKET_IMAGE_TYPES).join(', ')}`); continue; }
      if (!has.has(file)) { problems.push(`${name}: the listing names it, but the file does not exist`); continue; }
      const bytes = read(file);
      if (bytes.length > MARKET_LIMITS.file) { problems.push(`${name}: ${bytes.length} bytes, more than the ${MARKET_LIMITS.file} allowed`); continue; }
      if (bytes.length === 0) { problems.push(`${name}: the file is empty`); continue; }
      const sha256 = sha256Hex(bytes);
      pictures.set(filePath(sha256, extension), { sha256, extension, bytes });
      fileMap.push([name, filePath(sha256, extension)]);
    }
    if (problems.length) { errors.push(...problems.map((problem) => `${where}: ${problem}`)); continue; }
    prepared.push({
      id,
      manifest,
      setups: sortedRecord(Object.entries(setups).map(([name, value]) => [name.slice('setup/'.length), value])),
      files: sortedRecord(fileMap),
      entry: {
        id,
        kind: 'container',
        name: app.name,
        version: app.version,
        tagline: listing.tagline,
        description: listing.description,
        category: listing.category,
        tags: listing.tags,
        developer: listing.developer,
        icon: listing.icon_file ? fileMap.find(([name]) => name === listing.icon_file)?.[1] : undefined,
        requires: app.requires ? { youeye: app.requires.youeye } : undefined,
        runs_setup: Object.keys(setups).length > 0,
      },
      site: {
        id,
        kind: 'container',
        listed: true,
        name: app.name,
        version: app.version,
        tagline: listing.tagline,
        description: listing.description,
        longDescription: listing.long_description,
        releaseNotes: listing.release_notes,
        category: listing.category,
        tags: listing.tags,
        developer: listing.developer,
        license: listing.license,
        links: { website: listing.website, source_code: listing.source_code, support: listing.support, docs: listing.docs },
        icon: listing.icon_file ? fileMap.find(([name]) => name === listing.icon_file)?.[1] : undefined,
        screenshots: (listing.screenshots ?? []).map((shot) => ({ path: fileMap.find(([name]) => name === shot.path)![1], caption: shot.caption })),
        requiresYouEye: app.requires?.youeye.slice(2),
        runsSetup: Object.keys(setups).length > 0,
        youeyeId: Boolean(app.sso),
      },
    });
  }

  // Bundles.
  const bundles: Array<{ id: string; definition: string }> = [];
  const siteBundles: Array<{ id: string; name: string; description: string; summary?: string; members: string[] }> = [];
  for (const id of folders(files, 'bundles')) {
    const file = `bundles/${id}/bundle.yaml`;
    if (!has.has(file)) { errors.push(`bundles/${id}: missing bundle.yaml`); continue; }
    const definition = text(file);
    try {
      const bundle = parseBundle(definition);
      if (bundle.id !== id) errors.push(`${file}: id is "${bundle.id}"; it must equal the folder name`);
      for (const member of bundle.members) if (!known.has(member)) errors.push(`${file}: member "${member}" is not in the catalog`);
      for (const connection of bundle.connections ?? []) {
        for (const end of [connection.from, connection.to]) {
          if (!bundle.members.includes(end)) errors.push(`${file}: connection ${connection.from} → ${connection.to} names "${end}", which is not a member`);
        }
      }
      const checked = MarketIndexBundleSchema.safeParse({ id, definition });
      if (!checked.success) errors.push(`${file}: ${checked.error.issues[0]?.message ?? 'not a valid index bundle'}`);
      else {
        bundles.push({ id, definition });
        siteBundles.push({ id, name: bundle.name, description: bundle.description, summary: bundle.summary, members: bundle.members });
      }
    } catch (error) { errors.push(`${file}: ${message(error)}`); }
  }

  errors.push(...provenanceErrors(root, files, options.requireProvenance === true));

  // Notices: licence and notice files of app folders and of the repository root, published as text.
  const notices = new Map<string, Buffer>();
  const noticeSources = new Map<string, string>();
  for (const file of files) {
    const parts = file.split('/');
    const folder = parts.length === 1 ? 'notices' : parts.length === 3 && parts[0] === 'apps' && appIds.includes(parts[1]) ? `notices/${parts[1]}` : null;
    if (!folder) continue;
    const name = noticeOutputName(parts[parts.length - 1]);
    if (name === null) continue;
    if (typeof name !== 'string') { errors.push(`${file}: ${name.error}`); continue; }
    const output = `${folder}/${name}`;
    const other = noticeSources.get(output);
    if (other) { errors.push(`${file}: published as ${output}, the same as ${other}`); continue; }
    noticeSources.set(output, file);
    const size = lstatSync(path.join(root, file)).size;
    if (size > MAX_NOTICE_BYTES) { errors.push(`${file}: ${size} bytes, more than the ${MAX_NOTICE_BYTES} allowed for a notice file`); continue; }
    notices.set(output, read(file));
  }

  if (errors.length) throw new MarketBuildError(errors);

  // The files.
  const out = new Map<string, Buffer>();
  for (const [picturePath, picture] of [...pictures].sort(([a], [b]) => byPath(a, b))) out.set(picturePath, picture.bytes);
  const entries: Record<string, unknown>[] = [];
  let bundleBytes = 0;
  for (const app of prepared) {
    const bytes = json({ manifest: app.manifest, setups: app.setups, files: app.files });
    if (bytes.length > MARKET_LIMITS.bundle) { errors.push(`apps/${app.id}: its bundle is ${bytes.length} bytes, more than the ${MARKET_LIMITS.bundle} allowed`); continue; }
    const sha256 = sha256Hex(bytes);
    out.set(bundlePath(app.id, sha256), bytes);
    bundleBytes += bytes.length;
    const entry = JSON.parse(JSON.stringify({ ...app.entry, bundle: { path: bundlePath(app.id, sha256), sha256, size: bytes.length } }));
    const checked = MarketIndexEntrySchema.safeParse(entry);
    if (!checked.success) {
      for (const issue of checked.error.issues) errors.push(`apps/${app.id}: index entry ${issue.path.join('.')}: ${issue.message}`);
      continue;
    }
    entries.push(entry);
  }
  const index = json({
    schema: MARKET_INDEX_SCHEMA,
    categories: (catalog?.categories ?? []).map((category) => JSON.parse(JSON.stringify({
      id: category.id, label: category.label, icon: category.icon, order: category.order,
      tile: category.tile ? { bg: category.tile.bg, fg: category.tile.fg } : undefined,
    }))),
    curation: catalog?.curation ? JSON.parse(JSON.stringify({
      spotlight: catalog.curation.spotlight ? { title: catalog.curation.spotlight.title, apps: catalog.curation.spotlight.apps } : undefined,
      collections: catalog.curation.collections?.map((collection) => ({ id: collection.id, label: collection.label, apps: collection.apps })),
    })) : undefined,
    native,
    bundles,
    apps: entries,
  });
  if (index.length > MARKET_LIMITS.index) errors.push(`the index is ${index.length} bytes, more than the ${MARKET_LIMITS.index} allowed`);
  const indexSha = sha256Hex(index);
  out.set(indexPath(indexSha), index);
  const pointer = json(JSON.parse(JSON.stringify({
    schema: MARKET_SCHEMA,
    name: store.name,
    publisher: store.publisher,
    homepage: store.homepage,
    sequence: options.sequence,
    commit: options.commit,
    index: { path: indexPath(indexSha), sha256: indexSha, size: index.length },
  })));
  const checkedPointer = MarketPointerSchema.safeParse(JSON.parse(pointer.toString('utf8')));
  if (!checkedPointer.success) for (const issue of checkedPointer.error.issues) errors.push(`${MARKET_POINTER_FILE}: ${issue.path.join('.')}: ${issue.message}`);
  out.set(MARKET_POINTER_FILE, pointer);
  for (const [noticePath, bytes] of [...notices].sort(([a], [b]) => byPath(a, b))) out.set(noticePath, bytes);
  if (errors.length) throw new MarketBuildError(errors);

  // The website, from the same inputs.
  const nativeListing = options.site?.nativeListing ?? {};
  const noticeFiles = [...notices.keys()].sort(byPath);
  const site = buildSite({
    name: store.name as string,
    publisher: store.publisher as string,
    homepage: store.homepage as string | undefined,
    commit: options.commit,
    sequence: options.sequence,
    categories: (catalog?.categories ?? []).map((category) => ({ id: category.id, label: category.label, order: category.order })),
    curation: catalog?.curation,
    bundles: siteBundles,
    apps: [
      ...prepared.filter((app) => entries.some((entry) => entry.id === app.id)).map((app) => ({
        ...app.site,
        notices: noticeFiles.filter((file) => file.startsWith(`notices/${app.id}/`)),
      })),
      ...native.map((id): SiteApp => {
        const listed = nativeListing[id];
        return listed
          ? { id, kind: 'native', listed: true, name: listed.name, tagline: listed.tagline, description: listed.tagline ? undefined : listed.description,
            longDescription: listed.description, version: listed.version }
          : { id, kind: 'native', listed: false, name: nameFromId(id) };
      }),
    ],
    notices: noticeFiles.filter((file) => file.split('/').length === 2),
    pictures: new Map([...pictures].map(([picturePath, picture]) => [picturePath, picture.bytes])),
  }, { official: options.site?.official, address, nativeListing });
  let siteBytes = 0;
  let pages = 0;
  for (const [file, bytes] of site) {
    if (out.has(file)) throw new MarketBuildError([`the website would replace the market file ${file}`]);
    out.set(file, bytes);
    siteBytes += bytes.length;
    if (file.endsWith('.html')) pages += 1;
  }

  // The reader must accept what was built (in memory; verifyMarket repeats it from disk).
  const refused = verifyFiles((file) => out.get(file) ?? null);
  if (refused.length) throw new MarketBuildError(refused.map((problem) => `the format reader refuses the output: ${problem}`));

  const sum = (paths: string[]) => paths.reduce((total, file) => total + out.get(file)!.length, 0);
  return {
    files: new Map([...out].sort(([a], [b]) => byPath(a, b))),
    summary: {
      apps: entries.length,
      bundles: bundles.length,
      native: native.length,
      pictures: pictures.size,
      notices: notices.size,
      files: out.size,
      pages,
      bytes: {
        pointer: pointer.length,
        index: index.length,
        bundles: bundleBytes,
        pictures: sum([...pictures.keys()]),
        notices: sum([...notices.keys()]),
        site: siteBytes,
      },
    },
  };
}

/**
 * Read a market back the way a box does: pointer, index, every bundle and every picture,
 * each checked against the hash and size that pointed to it. Returns the problems found.
 */
export function verifyFiles(get: (file: string) => Buffer | null): string[] {
  const problems: string[] = [];
  const fetch = (file: string, sha256?: string, size?: number): Buffer | null => {
    const bytes = get(file);
    if (!bytes) { problems.push(`${file}: missing`); return null; }
    if (size !== undefined && bytes.length !== size) problems.push(`${file}: ${bytes.length} bytes, the reference says ${size}`);
    if (sha256 !== undefined && sha256Hex(bytes) !== sha256) problems.push(`${file}: its sha256 differs from the reference`);
    return bytes;
  };
  const checkPicture = (where: string, file: string) => {
    const promised = fileHashOf(file);
    if (!promised) { problems.push(`${where}: ${file} is not a picture path`); return; }
    const bytes = fetch(file, promised.sha256);
    if (bytes && bytes.length > MARKET_LIMITS.file) problems.push(`${file}: larger than the limit`);
  };
  try {
    const pointerBytes = fetch(MARKET_POINTER_FILE);
    if (!pointerBytes) return problems;
    const pointer = readMarketPointer(pointerBytes);
    const indexBytes = fetch(pointer.index.path, pointer.index.sha256, pointer.index.size);
    if (!indexBytes) return problems;
    const index = readMarketIndex(indexBytes);
    problems.push(...index.warnings);
    const raw = JSON.parse(indexBytes.toString('utf8')) as { apps: unknown[]; bundles?: unknown[] };
    if (index.apps.length !== raw.apps.length) problems.push(`the index has ${raw.apps.length} apps, the reader accepts ${index.apps.length}`);
    if (index.bundles.length !== (raw.bundles ?? []).length) problems.push('the reader refuses a bundle definition');
    for (const entry of index.apps) {
      if (entry.icon) checkPicture(`app ${entry.id} icon`, entry.icon);
      if (!entry.bundle) { problems.push(`app ${entry.id}: no bundle`); continue; }
      const bundleBytes = fetch(entry.bundle.path, entry.bundle.sha256, entry.bundle.size);
      if (!bundleBytes) continue;
      const bundle = readMarketAppBundle(bundleBytes);
      for (const [name, file] of Object.entries(bundle.files ?? {})) checkPicture(`app ${entry.id} ${name}`, file);
    }
  } catch (error) {
    problems.push(message(error));
  }
  return problems;
}

/** Write a built market into `out`, which must be missing or empty. */
export function writeMarket(out: string, market: BuiltMarket): void {
  if (existsSync(out) && readdirSync(out).length > 0) throw new Error(`${out} is not empty; the market is written into an empty folder`);
  for (const [file, bytes] of market.files) {
    mkdirSync(path.dirname(path.join(out, file)), { recursive: true });
    writeFileSync(path.join(out, file), bytes);
  }
}

/** Read a written market back from disk with the format's readers. */
export function verifyMarket(out: string): string[] {
  return verifyFiles((file) => {
    const full = path.join(out, file);
    return existsSync(full) ? readFileSync(full) : null;
  });
}

/** --commit and --sequence, from the arguments or else from the checkout's git HEAD. */
export function commitOf(root: string, commit: string | undefined, sequence: string | undefined): BuildOptions {
  const isGit = existsSync(path.join(root, '.git'));
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  if ((!commit || !sequence) && !isGit) {
    throw new Error(`${root} is not a git checkout: give --commit <sha> and --sequence <unix seconds>`);
  }
  if (isGit && (!commit || !sequence) && git('status', '--porcelain', '--untracked-files=no')) {
    console.error(`warning: ${root} has uncommitted changes; market.json names HEAD, the files are the working tree`);
  }
  const resolvedCommit = commit ?? git('rev-parse', 'HEAD');
  const seconds = sequence ?? git('log', '-1', '--format=%ct', 'HEAD');
  if (!/^\d+$/.test(seconds)) throw new Error(`--sequence must be Unix seconds, got "${seconds}"`);
  return { commit: resolvedCommit, sequence: Number(seconds) };
}

const kb = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(2)} MiB` : `${(bytes / 1024).toFixed(1)} KiB`);

function main(argv: string[]): number {
  const usage = [
    'usage: market-build.ts <market-repo-dir> --out <dir> [--commit <sha>] [--sequence <unix seconds>]',
    '         [--official | --address <https address of this market>] [--native-listing <file.json>] [--require-provenance]',
    '',
    '  --official        the official YouEye Market: each app page links https://my.youeye.me/app?id=<id>',
    '  --address <url>   this market\'s address (https, folder URL): the pages link https://my.youeye.me/add?market=<address>',
    '                    with neither, the website has no "Add to YouEye" button',
    '  --native-listing  JSON {"<id>": {"name", "tagline", "description", "version"}} for native apps;',
    '                    without it they are listed by a name made from the id, without a button',
    '  --require-provenance  refuse a repository without asset-provenance.json (the official lanes)',
    '  --sequence        Unix seconds (default: the commit time); at most 300 s ahead of this machine\'s clock',
  ].join('\n');
  const options: Record<string, string> = {};
  let official = false;
  let requireProvenance = false;
  const positional: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--official') official = true;
    else if (arg === '--require-provenance') requireProvenance = true;
    else if (['--out', '--commit', '--sequence', '--address', '--native-listing'].includes(arg)) {
      if (argv[index + 1] === undefined) { console.error(`${arg} needs a value\n${usage}`); return 2; }
      options[arg.slice(2)] = argv[index + 1];
      index += 1;
    } else if (arg.startsWith('-')) { console.error(`unknown option ${arg}\n${usage}`); return 2; }
    else positional.push(arg);
  }
  if (positional.length !== 1 || !options.out) { console.error(usage); return 2; }
  const root = path.resolve(positional[0]);
  const out = path.resolve(options.out);
  if (!existsSync(path.join(root, 'catalog.yaml')) && !existsSync(path.join(root, 'apps'))) {
    console.error(`${root} is not a market repository (no catalog.yaml or apps/)`);
    return 1;
  }
  let market: BuiltMarket;
  try {
    const nativeListing = options['native-listing'] ? readNativeListing(readFileSync(path.resolve(options['native-listing']), 'utf8')) : undefined;
    market = buildMarket(root, {
      ...commitOf(root, options.commit, options.sequence), requireProvenance, site: { official, address: options.address, nativeListing },
    });
  } catch (error) {
    const errors = error instanceof MarketBuildError ? error.errors : [message(error)];
    console.error(`The market was not built (${errors.length} problem${errors.length === 1 ? '' : 's'}):`);
    for (const line of errors) console.error(`  ${line}`);
    return 1;
  }
  try { writeMarket(out, market); } catch (error) { console.error(message(error)); return 1; }
  const refused = verifyMarket(out);
  if (refused.length) {
    console.error(`The written market in ${out} does not read back:`);
    for (const line of refused) console.error(`  ${line}`);
    return 1;
  }
  const { summary } = market;
  const pointer = JSON.parse(market.files.get(MARKET_POINTER_FILE)!.toString('utf8'));
  console.log(`Built ${pointer.name} (${pointer.publisher}) at ${pointer.commit}, sequence ${pointer.sequence}, into ${out}`);
  console.log(`  ${summary.apps} apps, ${summary.bundles} bundles, ${summary.native} native, ${summary.pictures} pictures, ${summary.notices} notices, ${summary.pages} pages; ${summary.files} files`);
  console.log(`  market.json ${summary.bytes.pointer} B, index ${kb(summary.bytes.index)}, app bundles ${kb(summary.bytes.bundles)}, `
    + `pictures ${kb(summary.bytes.pictures)}, notices ${kb(summary.bytes.notices)}, website ${kb(summary.bytes.site)}`);
  const button = official ? 'my.youeye.me/app?id=<id>' : options.address ? 'my.youeye.me/add?market=<address>' : 'none (give --official or --address)';
  console.log(`  "Add to YouEye" button: ${button}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
