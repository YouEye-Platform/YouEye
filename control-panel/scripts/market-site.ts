/**
 * The Market website: plain HTML pages that the generator (scripts/market-build.ts) writes next
 * to the market's files, so the same folder is what boxes read and what people browse.
 *
 *   index.html                       every app by category (curation first), bundles, search
 *   apps/<id>/index.html             one app: pictures, description, facts, links, notices
 *   make-your-own-market/index.html  how to publish a market
 *   notices/index.html               the licence and notice files
 *   site.css, site.js, fonts/        one stylesheet, one script (search), Geist (SIL OFL 1.1)
 *   youeye.svg                       the YouEye symbol (the official market only)
 *
 * Rules: every value from a manifest, a listing or the store is escaped (`html` escapes every
 * interpolation; only `raw` markup built here passes through); links out are https only and carry
 * rel="noopener noreferrer"; pages request nothing from another host (a Content-Security-Policy
 * meta tag allows only this origin); every link between pages is relative, so the folder works
 * under `/`, `/dev/` and `/test/<name>/`; and nothing depends on the build time (the date shown is
 * the commit time, `sequence`).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── Escaping ─────────────────────────────────────────────

const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Text for HTML content or a double-quoted attribute value. */
export function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ENTITIES[char]);
}

/** Markup built by this module. Nothing else is ever inserted unescaped. */
export class Raw {
  constructor(readonly value: string) {}
  toString(): string { return this.value; }
}

function render(value: unknown): string {
  if (value instanceof Raw) return value.value;
  if (Array.isArray(value)) return value.map(render).join('');
  if (value === null || value === undefined || value === false) return '';
  return esc(value);
}

/** A template whose every interpolation is escaped, unless it is `Raw` (or a list of them). */
export function html(strings: TemplateStringsArray, ...values: unknown[]): Raw {
  let out = strings[0];
  for (let index = 0; index < values.length; index += 1) out += render(values[index]) + strings[index + 1];
  return new Raw(out);
}

/** An https URL without credentials, normalised by the URL parser; null for anything else. */
export function httpsHref(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2000) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && url.hostname ? url.href : null;
  } catch { return null; }
}

// ─── Inputs ───────────────────────────────────────────────

export const MY_SITE = 'https://my.youeye.me';
export const YOUEYE_SITE = 'https://youeye.me';
export const MANIFEST_DOCS = 'https://github.com/YouEye-Platform/YouEye/blob/main/docs/app-manifest.md';

export interface SiteApp {
  id: string;
  /** `container`: OCI images; `native`: a Node.js app from its pinned package (YE-142). Both are listed the same way. */
  kind: 'container' | 'native';
  name: string;
  version?: string;
  tagline?: string;
  description?: string;
  longDescription?: string;
  releaseNotes?: string;
  category?: string;
  tags?: string[];
  developer?: string;
  license?: string;
  links?: { website?: string; source_code?: string; support?: string; docs?: string };
  /** Hashed picture paths (h/files/…). */
  icon?: string;
  screenshots?: Array<{ path: string; caption?: string }>;
  requiresYouEye?: string;
  runsSetup?: boolean;
  /** True when the app signs people in with YouEye ID. */
  youeyeId?: boolean;
  /** Output paths of its licence and notice files (notices/<id>/…). */
  notices?: string[];
}

export interface SiteInput {
  name: string;
  publisher: string;
  homepage?: string;
  commit: string;
  sequence: number;
  categories: Array<{ id: string; label: string; order?: number }>;
  curation?: { spotlight?: { title?: string; apps: string[] }; collections?: Array<{ id: string; label: string; apps: string[] }> };
  bundles: Array<{ id: string; name: string; description: string; summary?: string; members: string[] }>;
  apps: SiteApp[];
  /** Output paths of the repository's own licence and notice files (notices/<file>). */
  notices: string[];
  /** The market's pictures by hashed path (for width and height). */
  pictures: Map<string, Buffer>;
}

export interface SiteOptions {
  /** The official market: app pages link `my.youeye.me/app?id=<id>`. */
  official?: boolean;
  /** This market's address (normalised). Without `official`, pages link `my.youeye.me/add?market=<address>`. */
  address?: string;
}

// ─── Pictures ─────────────────────────────────────────────

/** Width and height read from a picture's header (PNG, GIF, WebP, JPEG); null when unknown. */
export function imageSize(bytes: Buffer, extension: string): { width: number; height: number } | null {
  try {
    if (extension === 'png' && bytes.length >= 24 && bytes.toString('latin1', 12, 16) === 'IHDR') {
      return checked(bytes.readUInt32BE(16), bytes.readUInt32BE(20));
    }
    if (extension === 'gif' && bytes.length >= 10 && bytes.toString('latin1', 0, 4) === 'GIF8') {
      return checked(bytes.readUInt16LE(6), bytes.readUInt16LE(8));
    }
    if (extension === 'webp' && bytes.length >= 30 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') {
      const chunk = bytes.toString('latin1', 12, 16);
      if (chunk === 'VP8 ') return checked(bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff);
      if (chunk === 'VP8L') {
        const [b0, b1, b2, b3] = [bytes[21], bytes[22], bytes[23], bytes[24]];
        return checked(1 + (((b1 & 0x3f) << 8) | b0), 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)));
      }
      if (chunk === 'VP8X') return checked(1 + bytes.readUIntLE(24, 3), 1 + bytes.readUIntLE(27, 3));
      return null;
    }
    if ((extension === 'jpg' || extension === 'jpeg') && bytes[0] === 0xff && bytes[1] === 0xd8) {
      let offset = 2;
      while (offset + 9 < bytes.length) {
        if (bytes[offset] !== 0xff) return null;
        const marker = bytes[offset + 1];
        if (marker === 0xff) { offset += 1; continue; }
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return checked(bytes.readUInt16BE(offset + 7), bytes.readUInt16BE(offset + 5));
        }
        offset += 2 + bytes.readUInt16BE(offset + 2);
      }
    }
  } catch { /* a short or odd header: no size */ }
  return null;
}

function checked(width: number, height: number): { width: number; height: number } | null {
  return width > 0 && height > 0 && width < 100000 && height < 100000 ? { width, height } : null;
}

// ─── Building blocks ──────────────────────────────────────

const CSP = "default-src 'none'; img-src 'self'; style-src 'self'; font-src 'self'; script-src 'self'; base-uri 'none'; form-action 'none'";

/** The commit time as a date (UTC), never the build time. */
export function commitDate(sequence: number): string {
  return new Date(sequence * 1000).toISOString().slice(0, 10);
}

/** Plain text with blank lines between paragraphs; a paragraph whose lines all start with "- " or "* " is a list. */
export function paragraphs(text: string | undefined): Raw {
  if (!text) return html``;
  const blocks = text.replace(/\r\n?/g, '\n').split(/\n[ \t]*\n/)
    .map((block) => block.split('\n').map((line) => line.trim()).filter(Boolean))
    .filter((lines) => lines.length > 0);
  return html`${blocks.map((lines) => (lines.every((line) => /^[-*] /.test(line))
    ? html`<ul>${lines.map((line) => html`<li>${line.slice(2)}</li>`)}</ul>\n`
    : html`<p>${lines.join(' ')}</p>\n`))}`;
}

interface Page { title: string; description: string; root: string; body: Raw; script?: boolean; current?: 'apps' | 'make' | 'notices' }

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function buildSite(input: SiteInput, options: SiteOptions = {}): Map<string, Buffer> {
  const official = Boolean(options.official);
  const address = options.address;
  const files = new Map<string, Buffer>();
  const apps = [...input.apps].sort((a, b) => byText(a.id, b.id));
  const appById = new Map(apps.map((app) => [app.id, app]));
  const categoryLabel = new Map(input.categories.map((category) => [category.id, category.label]));
  const date = commitDate(input.sequence);
  const shortCommit = input.commit.length > 12 ? input.commit.slice(0, 12) : input.commit;
  const homepage = official ? null : httpsHref(input.homepage);

  const addMarketLink = !official && address ? `${MY_SITE}/add?market=${encodeURIComponent(address)}` : null;
  const addAppLink = (app: SiteApp): string | null => {
    if (official) return `${MY_SITE}/app?id=${encodeURIComponent(app.id)}`;
    return addMarketLink;
  };

  const page = ({ title, description, root, body, script, current }: Page): Buffer => {
    const home = root || './';
    const nav = (key: Page['current'], href: string, label: string) =>
      html`<a href="${href}"${current === key ? new Raw(' aria-current="page"') : ''}>${label}</a>`;
    const text = html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<meta name="referrer" content="strict-origin-when-cross-origin">
<meta name="color-scheme" content="light dark">
<title>${title}</title>
<meta name="description" content="${description}">
<link rel="stylesheet" href="${root}site.css">
${official ? html`<link rel="icon" href="${root}youeye.svg" type="image/svg+xml">\n` : ''}${script ? html`<script src="${root}site.js" defer></script>\n` : ''}</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="top">
<div class="wrap">
<a class="brand" href="${home}">${official ? html`<img src="${root}youeye.svg" alt="" width="28" height="28">` : ''}<span>${input.name}</span></a>
<nav aria-label="Site">${nav('apps', home, 'Apps')}${nav('make', `${root}make-your-own-market/`, 'Make your own market')}</nav>
</div>
</header>
<main id="main">
<div class="wrap">
${body}
</div>
</main>
<footer class="foot">
<div class="wrap">
<nav aria-label="More">${nav('apps', home, 'All apps')}${nav('make', `${root}make-your-own-market/`, 'Make your own market')}${nav('notices', `${root}notices/`, 'Notices')}<a href="${YOUEYE_SITE}">About YouEye</a>${homepage ? html`<a href="${homepage}" rel="noopener noreferrer">Publisher’s website</a>` : ''}</nav>
<p>${input.name} is published by ${input.publisher}.${official ? '' : ' YouEye does not check the apps of markets it does not publish.'}</p>
<p>Built from commit <code title="${input.commit}">${shortCommit}</code> of ${date}.</p>
</div>
</footer>
</body>
</html>
`;
    return Buffer.from(text.value, 'utf8');
  };

  const iconOf = (app: SiteApp, root: string, large = false): Raw => {
    const size = large ? 72 : 48;
    if (app.icon) {
      return html`<img class="icon${large ? ' large' : ''}" src="${root}${app.icon}" alt="" width="${size}" height="${size}"${large ? '' : new Raw(' loading="lazy"')} decoding="async">`;
    }
    return html`<span class="icon letter${large ? ' large' : ''}" aria-hidden="true">${[...app.name][0]?.toUpperCase() ?? '?'}</span>`;
  };

  const taglineOf = (app: SiteApp) => app.tagline ?? app.description ?? '';

  // ── The index ──
  const card = (app: SiteApp): Raw => {
    const search = [app.name, app.id, app.tagline, app.description, ...(app.tags ?? []), app.category ? categoryLabel.get(app.category) : '', app.developer]
      .filter(Boolean).join(' ').toLowerCase().replace(/\s+/g, ' ');
    return html`<li data-kind="app" data-id="${app.id}" data-search="${search}"><a class="card" href="apps/${app.id}/">${iconOf(app, '')}<span class="text"><span class="name">${app.name}</span><span class="tagline">${taglineOf(app)}</span></span></a></li>\n`;
  };
  const sortedByName = (list: SiteApp[]) => [...list].sort((a, b) => byText(a.name.toLowerCase(), b.name.toLowerCase()) || byText(a.id, b.id));
  const section = (id: string, title: string, list: SiteApp[], note?: string): Raw => html`<section class="section" data-section id="${id}" aria-labelledby="${id}-title">
<h2 id="${id}-title">${title} <span class="count">${list.length}</span></h2>
${note ? html`<p class="muted">${note}</p>\n` : ''}<ul class="cards">
${list.map(card)}</ul>
</section>
`;

  const sections: Raw[] = [];
  const curated = new Set<string>();
  const pick = (ids: string[]) => ids.map((id) => appById.get(id)).filter((app): app is SiteApp => Boolean(app));
  const spotlight = input.curation?.spotlight;
  if (spotlight && pick(spotlight.apps).length) {
    const list = pick(spotlight.apps);
    list.forEach((app) => curated.add(app.id));
    sections.push(section('featured', spotlight.title || 'Featured', list));
  }
  for (const collection of input.curation?.collections ?? []) {
    const list = pick(collection.apps);
    if (!list.length) continue;
    list.forEach((app) => curated.add(app.id));
    sections.push(section(`collection-${collection.id.replace(/[^a-z0-9-]/gi, '-').toLowerCase()}`, collection.label, list));
  }
  const rest = apps.filter((app) => !curated.has(app.id));
  const categories = input.categories.map((category, position) => ({ ...category, position }))
    .sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) || a.position - b.position);
  for (const category of categories) {
    const list = sortedByName(rest.filter((app) => app.category === category.id));
    if (list.length) sections.push(section(`category-${category.id}`, category.label, list));
  }
  const uncategorised = sortedByName(rest.filter((app) => !(app.category && categoryLabel.has(app.category))));
  if (uncategorised.length) sections.push(section('more', 'More apps', uncategorised));

  const bundles = [...input.bundles].sort((a, b) => byText(a.id, b.id));
  const bundleBlock = bundles.length ? html`<section class="section" data-section id="bundles" aria-labelledby="bundles-title">
<h2 id="bundles-title">Bundles <span class="count">${bundles.length}</span></h2>
<p class="muted">A bundle installs several apps together and connects them.</p>
<ul class="bundles">
${bundles.map((bundle) => {
    const members = bundle.members.map((id) => appById.get(id));
    const search = [bundle.name, bundle.id, bundle.description, bundle.summary, ...members.map((app) => app?.name)]
      .filter(Boolean).join(' ').toLowerCase().replace(/\s+/g, ' ');
    return html`<li class="bundle" data-kind="bundle" data-id="${bundle.id}" data-search="${search}" id="bundle-${bundle.id}">
<h3>${bundle.name}</h3>
<p>${bundle.summary ?? bundle.description}</p>
<p class="members">Apps: ${members.map((app, index) => html`${index ? ', ' : ''}${app ? html`<a href="apps/${app.id}/">${app.name}</a>` : bundle.members[index]}`)}</p>
</li>
`;
  })}</ul>
</section>
` : html``;

  const count = apps.length;
  const indexBody = html`<div class="hero">
<h1>${input.name}</h1>
<p class="lead">${count} ${count === 1 ? 'app' : 'apps'} for <strong>YouEye</strong>, published by ${input.publisher}. YouEye is a personal cloud: a small server at home that runs your own apps. <a href="${YOUEYE_SITE}">Learn about YouEye</a></p>
${official ? '' : html`<p class="note">This market is not published by YouEye, and YouEye has not checked its apps. Add it to your YouEye only if you trust ${input.publisher}.</p>\n`}${addMarketLink ? html`<div class="add"><a class="button" href="${addMarketLink}">Add to YouEye</a><p>Opens your own YouEye and asks there whether to add this market. Nothing changes until you confirm.</p></div>\n` : ''}<form class="search" id="search" role="search" hidden>
<label for="search-input">Search apps</label>
<input id="search-input" type="search" autocomplete="off" spellcheck="false" placeholder="Name, purpose or tag">
<output id="search-status" for="search-input" aria-live="polite"></output>
</form>
<p class="empty" id="search-empty" hidden>No apps match your search.</p>
</div>
${sections}${bundleBlock}`;
  files.set('index.html', page({
    title: input.name,
    description: `${count} ${count === 1 ? 'app' : 'apps'} for YouEye, published by ${input.publisher}.`,
    root: '',
    body: indexBody,
    script: true,
    current: 'apps',
  }));

  // ── App pages ──
  for (const app of apps) {
    const root = '../../';
    const add = addAppLink(app);
    const addText = official
      ? `Opens ${app.name} in the Market of your own YouEye. Nothing is installed until you confirm there.`
      : `Opens your own YouEye and asks there whether to add this market, where you can install ${app.name}. Nothing changes until you confirm.`;
    const shots = (app.screenshots ?? []).map((shot, index) => {
      const size = input.pictures.has(shot.path) ? imageSize(input.pictures.get(shot.path)!, path.extname(shot.path).slice(1)) : null;
      const alt = shot.caption?.trim() || `${app.name}, picture ${index + 1}`;
      return html`<li><figure><img src="${root}${shot.path}" alt="${alt}"${size ? html` width="${size.width}" height="${size.height}"` : ''} loading="lazy" decoding="async">${shot.caption?.trim() ? html`<figcaption>${shot.caption.trim()}</figcaption>` : ''}</figure></li>\n`;
    });
    const linkRows = ([['website', 'Website'], ['source_code', 'Source code'], ['support', 'Support'], ['docs', 'Documentation']] as const)
      .flatMap(([key, label]): Array<[string, string]> => {
        const href = httpsHref(app.links?.[key]);
        return href ? [[label, href]] : [];
      });
    const facts: Array<[string, Raw | string]> = [];
    if (app.version) facts.push(['Version', html`<span class="mono">${app.version}</span>`]);
    if (app.category) facts.push(['Category', categoryLabel.get(app.category) ?? app.category]);
    if (app.developer) facts.push(['Developer', app.developer]);
    if (app.license) facts.push(['Licence', app.license]);
    facts.push(['Needs', app.requiresYouEye ? `YouEye ${app.requiresYouEye} or newer` : 'Any YouEye']);
    if (app.kind === 'native') facts.push(['Kind', 'Native app: it runs on Node.js in its own container and joins the dashboard']);
    facts.push(['Setup steps', app.runsSetup ? 'Yes: they run inside the app’s own containers when it is installed' : 'None']);
    if (app.youeyeId) facts.push(['Sign-in', 'With your YouEye ID']);
    if (app.tags?.length) facts.push(['Tags', html`<ul class="tags">${app.tags.map((tag) => html`<li>${tag}</li>`)}</ul>`]);
    if (linkRows.length) facts.push(['Links', html`<ul class="links">${linkRows.map(([label, href]) => html`<li><a href="${href}" rel="noopener noreferrer">${label}</a></li>`)}</ul>`]);
    if (app.notices?.length) {
      facts.push(['Notices', html`<ul class="files">${app.notices.map((file) => html`<li><a href="${root}${file}">${file.split('/').pop()}</a></li>`)}</ul>`]);
    }
    const about = app.longDescription ?? app.description;
    const body = html`<p class="crumbs"><a href="${root}">← All apps</a></p>
<div class="app-head">
${iconOf(app, root, true)}
<div class="titles">
<h1>${app.name}</h1>
${taglineOf(app) ? html`<p class="tagline">${taglineOf(app)}</p>\n` : ''}${app.developer || app.version ? html`<p class="meta">${[app.version ? `Version ${app.version}` : '', app.developer ? `by ${app.developer}` : ''].filter(Boolean).join(' · ')}</p>\n` : ''}${add ? html`<div class="add"><a class="button" href="${add}">Add to YouEye</a><p>${addText}</p></div>\n` : ''}</div>
</div>
<div class="layout">
<div class="prose">
${shots.length ? html`<h2 class="sr-only">Pictures</h2>\n<ul class="shots">\n${shots}</ul>\n` : ''}${about ? html`<h2>About ${app.name}</h2>\n${paragraphs(about)}` : ''}${app.releaseNotes ? html`<h2>What’s new${app.version ? html` in ${app.version}` : ''}</h2>\n${paragraphs(app.releaseNotes)}` : ''}</div>
${facts.length ? html`<aside class="facts" aria-labelledby="facts-title">
<h2 id="facts-title">Details</h2>
<dl>
${facts.map(([term, value]) => html`<dt>${term}</dt><dd>${value}</dd>\n`)}</dl>
</aside>
` : ''}</div>`;
    files.set(`apps/${app.id}/index.html`, page({
      title: `${app.name} · ${input.name}`,
      description: taglineOf(app) || `${app.name} for YouEye.`,
      root,
      body,
    }));
  }

  // ── Make your own market ──
  files.set('make-your-own-market/index.html', page({
    title: `Make your own market · ${input.name}`,
    description: 'How to publish your own market of apps for YouEye: a folder of static files on any HTTPS host.',
    root: '../',
    current: 'make',
    body: makeYourOwnMarket(),
  }));

  // ── Notices ──
  const appNotices = apps.filter((app) => app.notices?.length);
  files.set('notices/index.html', page({
    title: `Notices · ${input.name}`,
    description: `Licence and notice files of ${input.name}.`,
    root: '../',
    current: 'notices',
    body: html`<div class="narrow">
<h1>Notices</h1>
<p>The licence and notice files that come with this market, its apps and their pictures.</p>
${input.notices.length ? html`<h2>This market</h2>\n<ul>\n${input.notices.map((file) => html`<li><a href="../${file}">${file.slice('notices/'.length)}</a></li>\n`)}</ul>\n` : ''}${appNotices.map((app) => html`<h2 id="app-${app.id}"><a href="../apps/${app.id}/">${app.name}</a></h2>
<ul>
${(app.notices ?? []).map((file) => html`<li><a href="../${file}">${file.split('/').pop()}</a></li>\n`)}</ul>
`)}<h2>This website</h2>
<p>The fonts are Geist and Geist Mono, © 2024 The Geist Project Authors, under the SIL Open Font License 1.1: <a href="../fonts/Geist-OFL.txt">Geist-OFL.txt</a>, <a href="../fonts/GeistMono-OFL.txt">GeistMono-OFL.txt</a>.</p>
</div>`,
  }));

  // ── Static files ──
  for (const [from, to] of SITE_ASSETS) {
    if (to === 'youeye.svg' && !official) continue;
    files.set(to, readFileSync(path.join(ASSET_DIR, from)));
  }
  return files;
}

const ASSET_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'market-site');
/** [source under scripts/market-site/, output path]. */
const SITE_ASSETS: Array<[string, string]> = [
  ['site.css', 'site.css'],
  ['site.js', 'site.js'],
  ['youeye.svg', 'youeye.svg'],
  ['fonts/Geist.ttf', 'fonts/Geist.ttf'],
  ['fonts/GeistMono.ttf', 'fonts/GeistMono.ttf'],
  ['fonts/Geist-OFL.txt', 'fonts/Geist-OFL.txt'],
  ['fonts/GeistMono-OFL.txt', 'fonts/GeistMono-OFL.txt'],
];

function makeYourOwnMarket(): Raw {
  const layout = `store.yaml                    the market's name and publisher
catalog.yaml                  categories, featured apps, ids of YouEye's own apps
apps/<id>/youeye-app.yaml     one app: its manifest
apps/<id>/setup/<name>.yaml   its setup files, when it has any
apps/<id>/icon.svg            the pictures its listing names (icon, screenshots)
bundles/<id>/bundle.yaml      optional: apps that are installed together
LICENSE, apps/<id>/LICENSE…   licence and notice files (plain text, .txt or .md), published under notices/`;
  const store = `name: Example Market
publisher: Example People
homepage: https://example.org   # optional`;
  const catalog = `schema: youeye.catalog.v1
categories:
  - {id: utilities, label: Utilities, order: 1}`;
  const build = `cd control-panel
node --import tsx scripts/market-build.ts /path/to/my-market --out /path/to/site \\
  --address https://example.org/market/`;
  return html`<div class="narrow">
<h1>Make your own market</h1>
<p>Anyone can publish apps for YouEye. A market is a folder of static files: the same files that a YouEye reads to list and install the apps, and a website like this one for people to browse them. You keep the market’s files in a repository, build the folder with one command, and put it on any web host that serves HTTPS.</p>

<h2>The repository</h2>
<pre><code>${layout}</code></pre>
<p><code>store.yaml</code> says what the market is called and who publishes it; a YouEye shows these as the market’s own words:</p>
<pre><code>${store}</code></pre>
<p><code>catalog.yaml</code> holds what cannot be found from the folders, such as the categories:</p>
<pre><code>${catalog}</code></pre>
<p>Each app is a folder under <code>apps/</code> named by its id, with a <code>youeye-app.yaml</code> manifest. The manifest format is described in the <a href="${MANIFEST_DOCS}">app manifest reference</a> of the YouEye repository. A manifest may only use what the YouEye it names in <code>requires.youeye</code> understands; the build refuses it otherwise.</p>
<p>If the repository has an <code>asset-provenance.json</code>, every picture under <code>apps/</code> needs a current record in it; without that file, pictures are not checked against one.</p>

<h2>Build it</h2>
<p>The generator is part of the YouEye repository (<code>control-panel/scripts/market-build.ts</code>). In a YouEye checkout with its dependencies installed:</p>
<pre><code>${build}</code></pre>
<p>It checks every app the way a YouEye does and writes nothing when something is wrong; every problem is listed. The output folder must be empty. The same commit and options always build the same files. Outside a git checkout, give <code>--commit</code> and <code>--sequence</code> (the commit time in Unix seconds) yourself.</p>
<p>With <code>--address</code>, the pages of your market get an “Add to YouEye” button for that address.</p>

<h2>Host it</h2>
<p>Upload the folder to any static web host with HTTPS. The market’s address is the folder’s URL with a trailing slash, for example <code>https://example.org/market/</code>; a YouEye reads <code>market.json</code> there, and every other file through it. The address must answer directly: a YouEye does not follow redirects, and it only reads markets at public HTTPS addresses.</p>
<p>Each build names the commit and its time in <code>market.json</code>. A YouEye never goes back to an older commit of the same market, so to undo a change, publish a new commit.</p>

<h2>How people add it</h2>
<p>On their YouEye, in the Market’s <strong>Sources</strong> page, they add your market’s address. Or you give them a link:</p>
<pre><code>${MY_SITE}/add?market=&lt;your market’s address&gt;</code></pre>
<p>The link opens their own YouEye, which shows your market and asks before it adds anything; a link alone never changes a YouEye. <a href="${MY_SITE}/">my.youeye.me</a> makes these links for you, with an “Add to YouEye” badge.</p>

<h2>Trust</h2>
<p>Apps from markets that YouEye does not publish are not checked by YouEye. The owner of a YouEye must accept a market before it is used, so tell people who you are and what your apps do.</p>
</div>`;
}
