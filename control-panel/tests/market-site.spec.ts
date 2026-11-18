// The Market website (scripts/market-site.ts), written by the generator (scripts/market-build.ts)
// next to the market's files: every app has a page, every value is escaped, every link between
// pages resolves, nothing is loaded from another host, and the output is byte-identical.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stringify } from 'yaml';

import { MarketBuildError, buildMarket, verifyFiles, type BuildOptions, type BuiltMarket } from '../scripts/market-build';
import {
  MANIFEST_DOCS, commitDate, esc, html, httpsHref, imageSize, nameFromId, paragraphs, readNativeListing,
} from '../scripts/market-site';
import { appDocument } from './fixtures/app-format';

const controlRoot = process.env.CONTROL_PANEL_ROOT ?? path.resolve(__dirname, '..');
const BASE = { commit: '0123abcd', sequence: 1795000000 };
const yaml = (value: unknown) => stringify(value, { aliasDuplicateObjects: false });
const SVG = (color: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1" fill="${color}"/></svg>\n`;
// A PNG header of a 3 × 2 picture (enough for the size reader).
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000030000000208060000000000', 'hex');

function scratch(t: TestContext, prefix = 'market-site-'): string {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function put(root: string, file: string, content: string | Buffer): void {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), content);
}

const HOSTILE = `<script>alert("x")</script>"'&`;

/**
 * Two apps, a native id and a bundle. `hostile` fills every text a publisher controls with markup,
 * quotes and javascript: links; no asset-provenance.json (a market that is not the official one).
 */
function fixture(t: TestContext, hostile = false): string {
  const root = scratch(t, 'market-site-fixture-');
  const h = (text: string) => (hostile ? `${text} ${HOSTILE}` : text);
  put(root, 'store.yaml', yaml({ name: h('Demo Market'), publisher: h('Demo People'), homepage: 'https://people.example.org/' }));
  put(root, 'catalog.yaml', yaml({
    schema: 'youeye.catalog.v1',
    categories: [{ id: 'utilities', label: h('Utilities'), order: 1 }, { id: 'media', label: 'Media', order: 2 }],
    curation: { spotlight: { title: h('Ours'), apps: ['notes'] }, collections: [{ id: 'pair', label: h('Pair'), apps: ['alpha'] }] },
    native: ['notes'],
  }));
  put(root, 'apps/alpha/youeye-app.yaml', yaml(appDocument({
    id: 'alpha',
    name: h('Alpha'),
    sso: { callback: '/oauth/callback' },
    listing: {
      tagline: h('Alpha in a line'),
      description: h('What Alpha does.'),
      long_description: hostile
        ? 'First <img src=x onerror="alert(1)"> paragraph\nstill first.\n\n<a href="javascript:alert(1)">click</a> javascript:alert(2)\n\n- one <b>\n- two'
        : 'First paragraph\nstill first.\n\nSecond paragraph.\n\n- one\n- two',
      release_notes: h('Fixed things.'),
      category: 'utilities',
      tags: [h('demo')],
      icon_file: 'icon.svg',
      screenshots: [{ path: 'screenshots/a.png', caption: h('The first view') }, { path: 'screenshots/b.svg' }],
      website: hostile ? 'http://plain.example.org/' : 'https://alpha.example.org/',
      source_code: hostile ? 'https://code.example.org/"><script>alert(3)</script>' : 'https://code.example.org/alpha',
      support: 'https://help.example.org/',
      developer: h('Alpha people'),
      license: h('MIT'),
    },
  })));
  put(root, 'apps/alpha/icon.svg', SVG('red'));
  put(root, 'apps/alpha/screenshots/a.png', PNG);
  put(root, 'apps/alpha/screenshots/b.svg', SVG('blue'));
  put(root, 'apps/alpha/LICENSE.upstream.txt', 'Upstream licence\n');
  put(root, 'apps/beta/youeye-app.yaml', yaml(appDocument({
    id: 'beta', name: 'Beta', requires: { youeye: '>=0.6.9' },
    listing: { tagline: 'Beta in a line', category: 'media' },
  })));
  put(root, 'bundles/pair/bundle.yaml', yaml({ schema: 'youeye.bundle.v1', id: 'pair', name: h('Pair'), description: h('Both.'), members: ['alpha', 'beta'] }));
  put(root, 'LICENSE', 'Catalog licence\n');
  return root;
}

const page = (market: BuiltMarket, file: string) => market.files.get(file)!.toString('utf8');
const pages = (market: BuiltMarket) => [...market.files.keys()].filter((file) => file.endsWith('.html'));
const build = (root: string, site: BuildOptions['site'] = {}) => buildMarket(root, { ...BASE, site });

/** Every href and src of a page (entities decoded). */
function references(text: string): string[] {
  return [...text.matchAll(/\s(?:href|src)="([^"]*)"/g)].map((match) => match[1].replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"'));
}

/** The output file a relative reference from `file` names, or null for an absolute URL. */
function resolveRelative(file: string, reference: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(reference) || reference.startsWith('//')) return null;
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), reference.split(/[?#]/)[0] || path.posix.basename(file)));
  return target === '.' || target.endsWith('/') || reference.split(/[?#]/)[0].endsWith('/') || reference === './'
    ? path.posix.join(target, 'index.html') : target;
}

/** Absolute URLs a page may name. */
function allowedOutbound(url: string, appLinks: Set<string>): boolean {
  return url === 'https://youeye.me' || url.startsWith('https://my.youeye.me/') || url === MANIFEST_DOCS || appLinks.has(url);
}

function checkLinks(market: BuiltMarket, appLinks: Set<string>): void {
  for (const file of pages(market)) {
    for (const reference of references(page(market, file))) {
      const target = resolveRelative(file, reference);
      if (target === null) {
        assert.ok(allowedOutbound(reference, appLinks), `${file}: ${reference} is not an allowed outbound link`);
        assert.ok(reference.startsWith('https://'), `${file}: ${reference}`);
      } else {
        assert.ok(!target.startsWith('..'), `${file}: ${reference} leaves the market folder`);
        assert.ok(market.files.has(target), `${file}: ${reference} → ${target} does not exist`);
      }
    }
    // The stylesheet and the script are the only resources a page loads besides pictures and fonts.
    for (const match of page(market, file).matchAll(/<(link|script)\b[^>]*>/g)) {
      assert.match(match[0], /^<(link rel="(stylesheet|icon)"|script src=")/, `${file}: ${match[0]}`);
    }
  }
  // site.css loads only its own fonts.
  const css = market.files.get('site.css')!.toString('utf8');
  for (const match of css.matchAll(/url\(([^)]*)\)/g)) {
    const reference = match[1].replace(/["']/g, '');
    assert.ok(market.files.has(path.posix.normalize(reference)), `site.css: ${reference}`);
  }
  assert.doesNotMatch(css, /@import|https?:/);
}

test('every app has a page, the index links each of them, and every relative link resolves', (t) => {
  const market = build(fixture(t), { official: true });
  assert.deepEqual(verifyFiles((file) => market.files.get(file) ?? null), []);
  const index = page(market, 'index.html');
  for (const id of ['alpha', 'beta', 'notes']) {
    assert.ok(market.files.has(`apps/${id}/index.html`), id);
    assert.match(index, new RegExp(`href="apps/${id}/"`));
  }
  checkLinks(market, new Set(['https://alpha.example.org/', 'https://code.example.org/alpha', 'https://help.example.org/']));

  // Curation first (spotlight, collection), then the categories in their order; the bundles last.
  const order = ['id="featured"', 'id="collection-pair"', 'id="category-media"', 'id="bundles"'].map((marker) => index.indexOf(marker));
  assert.ok(order.every((position, i) => position > 0 && (i === 0 || position > order[i - 1])), String(order));
  assert.ok(!index.includes('id="category-utilities"'), 'Alpha is curated, so its category has no other app');
  assert.match(index, /<form class="search" id="search" role="search" hidden>/);
  assert.match(index, /<script src="site\.js" defer><\/script>/);

  const alpha = page(market, 'apps/alpha/index.html');
  assert.match(alpha, /<p>First paragraph still first\.<\/p>\n<p>Second paragraph\.<\/p>\n<ul><li>one<\/li><li>two<\/li><\/ul>/);
  assert.match(alpha, /<img src="\.\.\/\.\.\/h\/files\/[0-9a-f]{64}\.png" alt="The first view" width="3" height="2" loading="lazy" decoding="async"><figcaption>The first view<\/figcaption>/);
  assert.match(alpha, /<img src="\.\.\/\.\.\/h\/files\/[0-9a-f]{64}\.svg" alt="Alpha, picture 2" loading="lazy" decoding="async">/);
  assert.match(alpha, /<dt>Sign-in<\/dt><dd>With your YouEye ID<\/dd>/);
  assert.match(alpha, /<dt>Setup steps<\/dt><dd>None<\/dd>/);
  assert.match(alpha, /<a href="https:\/\/code\.example\.org\/alpha" rel="noopener noreferrer">Source code<\/a>/);
  assert.match(alpha, /<a href="\.\.\/\.\.\/notices\/alpha\/LICENSE\.upstream\.txt">LICENSE\.upstream\.txt<\/a>/);
  assert.match(alpha, /<h2>What’s new in 1\.0\.0<\/h2>\n<p>Fixed things\.<\/p>/);
  assert.match(page(market, 'apps/beta/index.html'), /<dt>Needs<\/dt><dd>YouEye 0\.6\.9 or newer<\/dd>/);

  // Every page: language, title, description, colour schemes and a strict content policy.
  for (const file of pages(market)) {
    const text = page(market, file);
    assert.match(text, /^<!doctype html>\n<html lang="en">/, file);
    assert.match(text, /<title>[^<]+<\/title>/, file);
    assert.match(text, /<meta name="description" content="[^"]+">/, file);
    assert.match(text, /<meta name="color-scheme" content="light dark">/, file);
    assert.match(text, /<meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; img-src &#39;self&#39;; style-src &#39;self&#39;; font-src &#39;self&#39;; script-src &#39;self&#39;; base-uri &#39;none&#39;; form-action &#39;none&#39;">/, file);
    assert.match(text, /<main id="main">/, file);
    assert.match(text, /Built from commit <code title="0123abcd">0123abcd<\/code> of 2026-11-18\./, file);
    for (const match of text.matchAll(/<img\b[^>]*>/g)) assert.match(match[0], / alt="/, `${file}: ${match[0]}`);
  }
  // The fonts and their licence are published; the official market has the YouEye symbol.
  for (const file of ['fonts/Geist.ttf', 'fonts/GeistMono.ttf', 'fonts/Geist-OFL.txt', 'fonts/GeistMono-OFL.txt', 'youeye.svg', 'site.css', 'site.js']) {
    assert.ok(market.files.has(file), file);
  }
});

test('the website is byte-identical on a rebuild and shows the commit time, never the build time', (t) => {
  const root = fixture(t);
  const listing = { notes: { name: 'Notes', tagline: 'Write things down', description: 'One.\n\nTwo.', version: '0.6.3' } };
  const first = build(root, { address: 'https://market.example.org/x', nativeListing: listing });
  const second = build(root, { address: 'https://market.example.org/x', nativeListing: listing });
  assert.deepEqual([...first.files.keys()], [...second.files.keys()]);
  for (const [file, bytes] of first.files) assert.ok(bytes.equals(second.files.get(file)!), file);
  assert.equal(commitDate(1795000000), '2026-11-18');
  const later = buildMarket(root, { commit: '0123abcd', sequence: 1795000000 + 86400 * 3, now: 1795000000 + 86400 * 3 });
  assert.match(page(later, 'index.html'), /of 2026-11-21\./);
});

test('a hostile listing is escaped everywhere: no markup, no script, no javascript: or http: links', (t) => {
  const root = fixture(t, true);
  const listing = readNativeListing(JSON.stringify({ notes: { name: `Notes ${HOSTILE}`, tagline: `javascript:alert(1) ${HOSTILE}`, description: HOSTILE } }));
  for (const site of [{ official: true, nativeListing: listing }, { address: 'https://market.example.org/' }, {}]) {
    const market = build(root, site);
    const allowedTags = new Set(['html', 'head', 'meta', 'title', 'link', 'script', 'body', 'a', 'header', 'div', 'img', 'span', 'nav', 'main',
      'p', 'form', 'label', 'input', 'output', 'section', 'h1', 'h2', 'h3', 'ul', 'li', 'figure', 'figcaption', 'aside', 'dl', 'dt', 'dd',
      'footer', 'code', 'pre', 'strong']);
    for (const file of pages(market)) {
      const text = page(market, file);
      for (const match of text.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^>]*)>/g)) {
        assert.ok(allowedTags.has(match[2].toLowerCase()), `${file}: unexpected tag ${match[0]}`);
        for (const attribute of match[3].matchAll(/\s([^\s=]+)(?:="([^"]*)")?/g)) {
          assert.doesNotMatch(attribute[1], /^on/i, `${file}: event attribute in ${match[0]}`);
          assert.match(attribute[1], /^(lang|charset|name|content|http-equiv|rel|href|type|src|defer|class|id|alt|width|height|loading|decoding|aria-[a-z]+|role|hidden|for|autocomplete|spellcheck|placeholder|title|data-[a-z]+)$/,
            `${file}: attribute ${attribute[1]} in ${match[0]}`);
        }
      }
      for (const match of text.matchAll(/<script\b[^>]*>/g)) assert.equal(match[0], '<script src="site.js" defer>', file);
      for (const reference of references(text)) {
        assert.doesNotMatch(reference, /^\s*(javascript|data|vbscript|http):/i, `${file}: ${reference}`);
      }
      assert.ok(!text.includes('<script>alert'), file);
      assert.ok(!text.includes('<img src=x'), file);
    }
    const alpha = page(market, 'apps/alpha/index.html');
    assert.ok(alpha.includes('Alpha &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&quot;&#39;&amp;'), 'the name is shown as text');
    assert.ok(alpha.includes('First &lt;img src=x onerror=&quot;alert(1)&quot;&gt; paragraph still first.'));
    assert.ok(!alpha.includes('plain.example.org'), 'an http: website is not linked');
    assert.ok(alpha.includes('href="https://code.example.org/%22%3E%3Cscript%3Ealert(3)%3C/script%3E"'), 'a URL is linked in its parsed form');
    checkLinks(market, new Set(['https://code.example.org/%22%3E%3Cscript%3Ealert(3)%3C/script%3E', 'https://help.example.org/', 'https://people.example.org/']));
  }
});

test('"Add to YouEye": official links my.youeye.me/app, another market my.youeye.me/add, none without either', (t) => {
  const root = fixture(t);
  const buttons = (market: BuiltMarket) => Object.fromEntries(pages(market).map((file) => [file,
    [...page(market, file).matchAll(/<a class="button" href="([^"]*)">Add to YouEye<\/a>/g)].map((match) => match[1].replace(/&amp;/g, '&'))]));

  const official = buttons(build(root, { official: true }));
  assert.deepEqual(official['index.html'], []);
  assert.deepEqual(official['apps/alpha/index.html'], ['https://my.youeye.me/app?id=alpha']);
  assert.deepEqual(official['apps/beta/index.html'], ['https://my.youeye.me/app?id=beta']);
  assert.deepEqual(official['apps/notes/index.html'], [], 'a native app without listing text has no button');

  const other = buttons(build(root, { address: 'https://Market.Example.org/x' }));
  const add = 'https://my.youeye.me/add?market=https%3A%2F%2Fmarket.example.org%2Fx%2F';
  assert.deepEqual(other['index.html'], [add]);
  assert.deepEqual(other['apps/alpha/index.html'], [add]);
  assert.deepEqual(other['apps/notes/index.html'], []);

  const none = build(root);
  assert.deepEqual(Object.values(buttons(none)).flat(), []);
  for (const file of pages(none).filter((file) => file !== 'make-your-own-market/index.html')) {
    assert.ok(!page(none, file).includes('my.youeye.me'), file);
  }
  assert.ok(!none.files.has('youeye.svg'), 'the YouEye symbol is on the official market only');
  assert.match(page(none, 'index.html'), /This market is not published by YouEye, and YouEye has not checked its apps\./);
  assert.match(page(none, 'index.html'), /<a href="https:\/\/people\.example\.org\/" rel="noopener noreferrer">Publisher’s website<\/a>/);

  for (const address of ['http://market.example.org/', 'https://user:pw@market.example.org/', 'https://market.example.org/?a=b', 'not a url']) {
    assert.throws(() => build(root, { address }), (error: unknown) => error instanceof MarketBuildError && /--address: /.test(error.message), address);
  }
});

test('native apps: a readable name without listing text; the listing\'s text, version and a button with it', (t) => {
  const root = fixture(t);
  const plain = build(root, { official: true });
  assert.match(page(plain, 'index.html'), /<span class="name">Notes<\/span><span class="tagline">Ships with YouEye<\/span>/);
  assert.match(page(plain, 'apps/notes/index.html'), /Notes is one of YouEye’s own apps; it ships with YouEye\. Open the Market on your YouEye to install it\./);

  const listed = build(root, { official: true, nativeListing: { notes: { name: 'YouEye Notes', tagline: 'Write things down', description: 'One.\n\nTwo.', version: '0.6.3' } } });
  const notes = page(listed, 'apps/notes/index.html');
  assert.match(notes, /<h1>YouEye Notes<\/h1>/);
  assert.match(notes, /<p class="tagline">Write things down<\/p>/);
  assert.match(notes, /<p>One\.<\/p>\n<p>Two\.<\/p>/);
  assert.match(notes, /<dt>Version<\/dt><dd><span class="mono">0\.6\.3<\/span><\/dd>/);
  assert.match(notes, /<a class="button" href="https:\/\/my\.youeye\.me\/app\?id=notes">Add to YouEye<\/a>/);

  assert.throws(() => readNativeListing('[]'), /must be a JSON object/);
  assert.throws(() => readNativeListing('{"Notes": {"name": "x"}}'), /is not an app id/);
  assert.throws(() => readNativeListing('{"notes": {"tagline": "x"}}'), /notes\.name is required/);
  assert.throws(() => readNativeListing('{"notes": {"name": 3}}'), /notes\.name must be text/);
  assert.throws(() => readNativeListing(`{"notes": {"name": "${'x'.repeat(121)}"}}`), /notes\.name must be text of 1–120/);
  assert.deepEqual(readNativeListing('{"wiki": {"name": "Wiki", "icon": "ignored"}, "notes": {"name": "Notes"}}'),
    { notes: { name: 'Notes' }, wiki: { name: 'Wiki' } });
  assert.equal(nameFromId('open-webui'), 'Open Webui');
});

test('the command line takes --official, --address and --native-listing', (t) => {
  const root = fixture(t);
  const out = scratch(t);
  const listing = path.join(scratch(t), 'native.json');
  writeFileSync(listing, JSON.stringify({ notes: { name: 'Notes', tagline: 'Write things down' } }));
  const run = (dir: string, ...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', 'scripts/market-build.ts', root, '--out', dir,
    '--commit', BASE.commit, '--sequence', String(BASE.sequence), ...args], { cwd: controlRoot, encoding: 'utf8' });
  const result = run(out, '--address', 'https://market.example.org/x/', '--native-listing', listing);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /"Add to YouEye" button: my\.youeye\.me\/add\?market=<address>/);
  assert.match(readFileSync(path.join(out, 'apps/notes/index.html'), 'utf8'), /my\.youeye\.me\/add\?market=https%3A%2F%2Fmarket\.example\.org%2Fx%2F/);
  const tree = (dir: string, prefix = ''): string[] => readdirSync(path.join(dir, prefix)).sort().flatMap((name) => {
    const rel = prefix ? `${prefix}/${name}` : name;
    return statSync(path.join(dir, rel)).isDirectory() ? tree(dir, rel) : [rel];
  });
  assert.ok(tree(out).includes('make-your-own-market/index.html'));

  const official = run(scratch(t), '--official');
  assert.equal(official.status, 0, official.stderr);
  assert.match(official.stdout, /"Add to YouEye" button: my\.youeye\.me\/app\?id=<id>/);
  const bad = run(scratch(t), '--address', 'http://market.example.org/');
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /--address: A market address must start with https:\/\//);
  const usage = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/market-build.ts'], { cwd: controlRoot, encoding: 'utf8' });
  assert.match(usage.stderr, /with neither, the website has no "Add to YouEye" button/);
});

test('the real catalog: a page per app, links that resolve, no other host but the apps\' own links', (t) => {
  const marketRoot = [process.env.MARKET_ROOT, path.join(controlRoot, '..', '..', 'YE-AppMarket')]
    .find((candidate): candidate is string => Boolean(candidate) && existsSync(path.join(candidate!, 'catalog.yaml')));
  if (!marketRoot) { t.skip('YE-AppMarket repo not checked out beside YouEye (set MARKET_ROOT)'); return; }
  const market = buildMarket(marketRoot, { ...BASE, site: { official: true } });
  const apps = readdirSync(path.join(marketRoot, 'apps')).filter((name) => statSync(path.join(marketRoot, 'apps', name)).isDirectory());
  for (const id of apps) assert.ok(market.files.has(`apps/${id}/index.html`), id);
  // The apps' own links are the ones in the "Links" lists of their pages; anything else must be ours.
  const appLinks = new Set(pages(market).flatMap((file) => [...page(market, file).matchAll(/<ul class="links">(.*?)<\/ul>/g)]
    .flatMap((list) => references(list[1]))));
  assert.ok(appLinks.size > apps.length);
  checkLinks(market, appLinks);
});

test('helpers: escaping, https links, paragraphs and picture sizes', () => {
  assert.equal(esc(`<a href="x">'&`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;');
  assert.equal(html`<p title="${'"><script>'}">${'<b>'}</p>`.value, '<p title="&quot;&gt;&lt;script&gt;">&lt;b&gt;</p>');
  assert.equal(httpsHref('javascript:alert(1)'), null);
  assert.equal(httpsHref('http://example.org/'), null);
  assert.equal(httpsHref('https://user@example.org/'), null);
  assert.equal(httpsHref('https://example.org/a b'), 'https://example.org/a%20b');
  assert.equal(paragraphs('a\nb\n\n\nc').value, '<p>a b</p>\n<p>c</p>\n');
  assert.deepEqual(imageSize(PNG, 'png'), { width: 3, height: 2 });
  assert.deepEqual(imageSize(Buffer.from('GIF89a\x05\x00\x07\x00', 'latin1'), 'gif'), { width: 5, height: 7 });
  const vp8x = Buffer.alloc(30);
  vp8x.write('RIFF', 0, 'latin1'); vp8x.write('WEBP', 8, 'latin1'); vp8x.write('VP8X', 12, 'latin1');
  vp8x.writeUIntLE(1919, 24, 3); vp8x.writeUIntLE(1079, 27, 3);
  assert.deepEqual(imageSize(vp8x, 'webp'), { width: 1920, height: 1080 });
  const jpeg = Buffer.from('ffd8ffe000104a46494600010100000100010000ffc0001108002a0040030122000211010311', 'hex');
  assert.deepEqual(imageSize(jpeg, 'jpg'), { width: 64, height: 42 });
  assert.equal(imageSize(Buffer.from('nope'), 'png'), null);
});
