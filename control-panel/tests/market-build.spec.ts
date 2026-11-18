// The Market generator (scripts/market-build.ts): a catalog repository becomes a folder of static
// files in the published format (src/lib/market/market-format.ts) that the box's readers accept.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stringify } from 'yaml';

import {
  MAX_NOTICE_BYTES, MarketBuildError, buildMarket, noticeOutputName, verifyFiles, verifyMarket, writeMarket, type BuiltMarket,
} from '../scripts/market-build';
import { loadApp } from '../src/lib/market/app-format/compile';
import { FIELDS_SINCE, type FieldSince } from '../src/lib/market/app-format/since';
import {
  MARKET_LIMITS, fileHashOf, readMarketAppBundle, readMarketIndex, readMarketPointer, sha256Hex,
} from '../src/lib/market/market-format';
import { PIN, appDocument } from './fixtures/app-format';

const controlRoot = process.env.CONTROL_PANEL_ROOT ?? path.resolve(__dirname, '..');
const OPTIONS = { commit: '0123abcd', sequence: 1795000000 };
const yaml = (value: unknown) => stringify(value, { aliasDuplicateObjects: false });
const SVG = (color: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1" fill="${color}"/></svg>\n`;
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

function scratch(t: TestContext, prefix = 'market-build-'): string {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function put(root: string, file: string, content: string | Buffer): void {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), content);
}

/** Every picture under apps/ gets a provenance record (call after the pictures change). */
function writeProvenance(root: string, except: string[] = []): void {
  const assets: unknown[] = [];
  for (const id of readdirSync(path.join(root, 'apps')).sort()) {
    const walk = (dir: string) => {
      for (const name of readdirSync(path.join(root, dir)).sort()) {
        const rel = `${dir}/${name}`;
        if (statSync(path.join(root, rel)).isDirectory()) walk(rel);
        else if (/\.(svg|png|jpe?g|webp|gif)$/.test(name) && !except.includes(rel)) {
          assets.push({ path: rel, sha256: `sha256:${sha256Hex(readFileSync(path.join(root, rel)))}`,
            source: 'https://example.org/picture', evidence: 'local-capture', notes: 'Fixture.' });
        }
      }
    };
    walk(`apps/${id}`);
  }
  put(root, 'asset-provenance.json', `${JSON.stringify({ apiVersion: 'youeye.market/asset-provenance/v1', assets }, null, 2)}\n`);
}

function listing(name: string, extra: Record<string, unknown> = {}) {
  return { tagline: `${name} in a line`, description: `What ${name} does.`, long_description: `All about ${name}.`,
    category: 'utilities', tags: ['demo'], icon: 'box', icon_file: 'icon.svg', developer: `${name} people`, ...extra };
}

/** A small catalog: two apps (one with setup files, screenshots and notices), one native id, one bundle. */
function fixture(t: TestContext): string {
  const root = scratch(t, 'market-fixture-');
  put(root, 'store.yaml', 'apiVersion: v1\nkind: store\nid: demo\nname: Demo Market\npublisher: Demo People\nhomepage: https://market.example.org\n');
  put(root, 'catalog.yaml', yaml({
    schema: 'youeye.catalog.v1',
    categories: [{ id: 'utilities', label: 'Utilities', icon: 'wrench', order: 1, tile: { bg: '#fff', fg: '#000' } }],
    curation: { spotlight: { title: 'Ours', apps: ['notes'] }, collections: [{ id: 'pair', label: 'Pair', apps: ['alpha', 'beta'] }] },
    native: ['notes'],
  }));
  put(root, 'apps/alpha/youeye-app.yaml', yaml(appDocument({
    id: 'alpha', name: 'Alpha',
    listing: listing('Alpha', { screenshots: [{ path: 'screenshots/a.png', caption: 'The first view' }, { path: 'screenshots/b.svg', caption: 'Shared' }] }),
  })));
  put(root, 'apps/alpha/setup/install.yaml', yaml({ schema: 'youeye.setup.v1', for: 'install', steps: [{ wait: { http: '/health' } }] }));
  put(root, 'apps/alpha/icon.svg', SVG('red'));
  put(root, 'apps/alpha/screenshots/a.png', PNG);
  put(root, 'apps/alpha/screenshots/b.svg', SVG('blue'));
  put(root, 'apps/alpha/LICENSE.upstream.txt', 'Upstream licence\n');
  put(root, 'apps/alpha/ASSET-NOTICES.md', '# Notices\n');
  put(root, 'apps/beta/youeye-app.yaml', yaml(appDocument({ id: 'beta', name: 'Beta', listing: listing('Beta') })));
  put(root, 'apps/beta/icon.svg', SVG('blue'));
  put(root, 'bundles/pair/bundle.yaml', yaml({ schema: 'youeye.bundle.v1', id: 'pair', name: 'Pair', description: 'Both.', members: ['alpha', 'beta'] }));
  put(root, 'LICENSE', 'Catalog licence\n');
  put(root, 'README.md', 'Not published\n');
  writeProvenance(root);
  return root;
}

function refused(root: string, pattern: RegExp): void {
  assert.throws(() => buildMarket(root, OPTIONS), (error: unknown) => {
    assert.ok(error instanceof MarketBuildError, String(error));
    assert.match(error.message, pattern);
    return true;
  });
}

function refused2(root: string, options: Parameters<typeof buildMarket>[1], pattern: RegExp): void {
  assert.throws(() => buildMarket(root, options), (error: unknown) => {
    assert.ok(error instanceof MarketBuildError, String(error));
    assert.match(error.message, pattern);
    return true;
  });
}

const json = (market: BuiltMarket, file: string) => JSON.parse(market.files.get(file)!.toString('utf8'));

test('a catalog builds into files the format readers accept, with right hashes and sizes', (t) => {
  const root = fixture(t);
  const market = buildMarket(root, OPTIONS);
  assert.deepEqual(verifyFiles((file) => market.files.get(file) ?? null), []);

  const pointer = readMarketPointer(market.files.get('market.json')!);
  assert.deepEqual(json(market, 'market.json'), {
    schema: 'youeye.market.v1', name: 'Demo Market', publisher: 'Demo People', homepage: 'https://market.example.org',
    sequence: OPTIONS.sequence, commit: OPTIONS.commit, index: pointer.index,
  });
  const indexBytes = market.files.get(pointer.index.path)!;
  assert.equal(sha256Hex(indexBytes), pointer.index.sha256);
  assert.equal(indexBytes.length, pointer.index.size);
  const index = readMarketIndex(indexBytes);
  assert.deepEqual(index.warnings, []);
  assert.deepEqual(index.native, ['notes']);
  assert.deepEqual(index.categories.map((category) => category.id), ['utilities']);
  assert.deepEqual(index.curation?.collections?.[0].apps, ['alpha', 'beta']);
  assert.deepEqual(index.bundles.map((bundle) => bundle.id), ['pair']);
  assert.match(index.bundles[0].definition, /^schema: youeye\.bundle\.v1/);

  assert.deepEqual(index.apps.map((app) => app.id), ['alpha', 'beta']);
  const [alpha, beta] = index.apps;
  assert.deepEqual(Object.keys(json(market, pointer.index.path).apps[0]),
    ['id', 'kind', 'name', 'version', 'tagline', 'description', 'category', 'tags', 'developer', 'icon', 'runs_setup', 'bundle']);
  assert.equal(alpha.kind, 'container');
  assert.equal(alpha.description, 'What Alpha does.');
  assert.equal(alpha.runs_setup, true);
  assert.equal(beta.runs_setup, false);
  for (const app of index.apps) {
    const bytes = market.files.get(app.bundle!.path)!;
    assert.equal(sha256Hex(bytes), app.bundle!.sha256);
    assert.equal(bytes.length, app.bundle!.size);
    assert.equal(app.bundle!.path, `h/apps/${app.id}/${app.bundle!.sha256}.json`);
  }

  const bundle = readMarketAppBundle(market.files.get(alpha.bundle!.path)!);
  assert.equal(bundle.manifest, readFileSync(path.join(root, 'apps/alpha/youeye-app.yaml'), 'utf8'));
  assert.equal(bundle.setups!['install.yaml'], readFileSync(path.join(root, 'apps/alpha/setup/install.yaml'), 'utf8'));
  assert.deepEqual(Object.keys(bundle.setups ?? {}), ['install.yaml']);
  assert.deepEqual(Object.keys(bundle.files ?? {}), ['icon.svg', 'screenshots/a.png', 'screenshots/b.svg']);
  assert.equal(bundle.files!['icon.svg'], alpha.icon);
  // The manifest and setup files load as the box loads them (setup files under setup/).
  const loaded = loadApp({ manifest: bundle.manifest, setups: Object.fromEntries(Object.entries(bundle.setups ?? {}).map(([name, text]) => [`setup/${name}`, text])) });
  assert.equal(loaded.metadata.id, 'alpha');

  // Pictures are named by their hash; identical pictures (Alpha's b.svg, Beta's icon) are stored once.
  for (const file of Object.values(bundle.files ?? {})) assert.equal(sha256Hex(market.files.get(file)!), fileHashOf(file)!.sha256);
  assert.equal(bundle.files!['screenshots/b.svg'], beta.icon);
  assert.equal([...market.files.keys()].filter((file) => file.startsWith('h/files/')).length, 3);
  assert.equal(market.summary.pictures, 3);

  // Notices are copied unchanged (a name without .txt or .md gets .txt); besides them only the website is published.
  const website = /^(index\.html|(apps\/[a-z0-9-]+|make-your-own-market|notices)\/index\.html|site\.css|site\.js|fonts\/Geist(Mono)?(\.ttf|-OFL\.txt))$/;
  assert.deepEqual([...market.files.keys()].filter((file) => !file.startsWith('h/') && file !== 'market.json' && !website.test(file)),
    ['notices/LICENSE.txt', 'notices/alpha/ASSET-NOTICES.md', 'notices/alpha/LICENSE.upstream.txt']);
  assert.equal(market.files.get('notices/LICENSE.txt')!.toString(), 'Catalog licence\n');
  assert.deepEqual([...market.files.keys()].filter((file) => file.endsWith('.html')),
    ['apps/alpha/index.html', 'apps/beta/index.html', 'apps/notes/index.html', 'index.html', 'make-your-own-market/index.html', 'notices/index.html']);
  assert.equal(market.summary.pages, 6);
  assert.equal(market.files.get('notices/alpha/LICENSE.upstream.txt')!.toString(), 'Upstream licence\n');
});

test('the same commit builds byte-identical output, also through the command line', (t) => {
  const root = fixture(t);
  const [first, second] = [scratch(t), scratch(t)];
  writeMarket(first, buildMarket(root, OPTIONS));
  const cli = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/market-build.ts', root, '--out', second,
    '--commit', OPTIONS.commit, '--sequence', String(OPTIONS.sequence)], { cwd: controlRoot, encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stdout + cli.stderr);
  assert.match(cli.stdout, /2 apps, 1 bundles, 1 native, 3 pictures, 3 notices, 6 pages; \d+ files/);
  assert.match(cli.stdout, /"Add to YouEye" button: none \(give --official or --address\)/);
  const tree = (dir: string, prefix = ''): string[] => readdirSync(path.join(dir, prefix)).sort().flatMap((name) => {
    const rel = prefix ? `${prefix}/${name}` : name;
    return statSync(path.join(dir, rel)).isDirectory() ? tree(dir, rel) : [rel];
  });
  assert.deepEqual(tree(second), tree(first));
  for (const file of tree(first)) assert.ok(readFileSync(path.join(first, file)).equals(readFileSync(path.join(second, file))), file);
  assert.deepEqual(verifyMarket(second), []);
  assert.ok(!readFileSync(path.join(second, 'market.json'), 'utf8').includes(root), 'no host paths');

  // The output folder must be empty; a plain export needs --commit and --sequence.
  const again = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/market-build.ts', root, '--out', second,
    '--commit', OPTIONS.commit, '--sequence', String(OPTIONS.sequence)], { cwd: controlRoot, encoding: 'utf8' });
  assert.equal(again.status, 1);
  assert.match(again.stderr, /is not empty/);
  const bare = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/market-build.ts', root, '--out', path.join(first, 'x')],
    { cwd: controlRoot, encoding: 'utf8' });
  assert.equal(bare.status, 1);
  assert.match(bare.stderr, /not a git checkout: give --commit <sha> and --sequence <unix seconds>/);
});

test('a changed app changes only its bundle, its pictures, its page, the index and market.json', (t) => {
  const root = fixture(t);
  const before = buildMarket(root, OPTIONS);
  const manifest = path.join(root, 'apps/alpha/youeye-app.yaml');
  writeFileSync(manifest, readFileSync(manifest, 'utf8').replace('version: 1.0.0', 'version: 1.0.1'));
  put(root, 'apps/alpha/screenshots/a.png', Buffer.concat([PNG, Buffer.from([0])]));
  writeProvenance(root);
  const after = buildMarket(root, OPTIONS);

  const removed = [...before.files.keys()].filter((file) => !after.files.has(file));
  const added = [...after.files.keys()].filter((file) => !before.files.has(file));
  const changed = [...after.files.keys()].filter((file) => before.files.has(file) && !before.files.get(file)!.equals(after.files.get(file)!));
  const kinds = (files: string[]) => files.map((file) => file.replace(/[0-9a-f]{64}/, '<sha>')).sort();
  assert.deepEqual(kinds(removed), ['h/apps/alpha/<sha>.json', 'h/files/<sha>.png', 'h/index/<sha>.json']);
  assert.deepEqual(kinds(added), ['h/apps/alpha/<sha>.json', 'h/files/<sha>.png', 'h/index/<sha>.json']);
  assert.deepEqual(changed, ['apps/alpha/index.html', 'market.json']);
  const entry = (market: BuiltMarket, id: string) => readMarketIndex(market.files.get(readMarketPointer(market.files.get('market.json')!).index.path)!)
    .apps.find((app) => app.id === id)!;
  assert.deepEqual(entry(after, 'beta'), entry(before, 'beta'));
  assert.equal(entry(after, 'alpha').version, '1.0.1');
});

test('an app using a field newer than its requires.youeye is refused (rows above the market format\'s floor)', (t) => {
  const root = fixture(t);
  const sidecarApp = (requires?: string) => yaml(appDocument({
    id: 'beta', name: 'Beta', listing: listing('Beta'), data: ['/data'],
    ...(requires ? { requires: { youeye: requires } } : {}),
    sidecars: [{ name: 'worker', image: `ghcr.io/example/worker${PIN}`, data: [{ path: '/data', from: 'main' }] }],
  }));
  // Every row so far is at or below 0.6.11, the oldest YouEye that reads a generated market: no requires needed.
  put(root, 'apps/beta/youeye-app.yaml', sidecarApp());
  assert.ok(buildMarket(root, OPTIONS));
  put(root, 'apps/alpha/youeye-app.yaml', yaml(appDocument({ id: 'alpha', name: 'Alpha', public_access: true,
    listing: listing('Alpha', { screenshots: [{ path: 'screenshots/a.png', caption: 'The first view' }, { path: 'screenshots/b.svg', caption: 'Shared' }] }) })));
  assert.ok(buildMarket(root, OPTIONS));

  // A row above the floor is enforced (a future field, added to the table for this test).
  const rows = FIELDS_SINCE as FieldSince[];
  rows.push({ document: 'app', field: 'sidecars[].data[].from', since: '0.7.1' });
  t.after(() => { rows.pop(); });
  refused(root, /apps\/beta: youeye-app\.yaml: sidecars\[\]\.data\[\]\.from needs YouEye 0\.7\.1, but requires\.youeye is missing/);
  put(root, 'apps/beta/youeye-app.yaml', sidecarApp('>=0.7.0'));
  refused(root, /sidecars\[\]\.data\[\]\.from needs YouEye 0\.7\.1, but requires\.youeye is ">=0\.7\.0"/);
  put(root, 'apps/beta/youeye-app.yaml', sidecarApp('>=0.7.1'));
  const market = buildMarket(root, OPTIONS);
  const index = readMarketIndex(market.files.get(readMarketPointer(market.files.get('market.json')!).index.path)!);
  assert.deepEqual(index.apps.find((app) => app.id === 'beta')!.requires, { youeye: '>=0.7.1' });
});

test('an unknown manifest field, a wrong id and an unnamed setup file are refused, all at once', (t) => {
  const root = fixture(t);
  const manifest = path.join(root, 'apps/alpha/youeye-app.yaml');
  writeFileSync(manifest, `${readFileSync(manifest, 'utf8')}colour: blue\n`);
  put(root, 'apps/beta/youeye-app.yaml', yaml(appDocument({ id: 'gamma', name: 'Beta', listing: listing('Beta') })));
  put(root, 'apps/beta/setup/connect-alpha.yaml', yaml({ schema: 'youeye.setup.v1', for: 'connect:alpha', steps: [{ sleep: 1 }] }));
  assert.throws(() => buildMarket(root, OPTIONS), (error: unknown) => {
    assert.ok(error instanceof MarketBuildError);
    assert.match(error.message, /apps\/alpha: youeye-app\.yaml: colour: unknown field "colour"/);
    assert.match(error.message, /apps\/beta: .*no connects entry for app "alpha" names this file/);
    return true;
  });
  rmSync(path.join(root, 'apps/beta/setup'), { recursive: true });
  refused(root, /apps\/beta: id is "gamma"; it must equal the folder name/);
});

test('pictures: provenance is required and current, and a picture over the limit is refused', (t) => {
  const root = fixture(t);
  writeProvenance(root, ['apps/alpha/screenshots/a.png']);
  refused(root, /apps\/alpha\/screenshots\/a\.png: picture has no record in asset-provenance\.json/);

  writeProvenance(root);
  put(root, 'apps/alpha/screenshots/a.png', Buffer.concat([PNG, Buffer.from([1])]));
  refused(root, /asset-provenance\.json: apps\/alpha\/screenshots\/a\.png: sha256 is stale/);

  put(root, 'apps/alpha/screenshots/a.png', Buffer.alloc(MARKET_LIMITS.file + 1, 1));
  writeProvenance(root);
  refused(root, /apps\/alpha: screenshots\/a\.png: 5242881 bytes, more than the 5242880 allowed/);

  put(root, 'apps/alpha/screenshots/a.png', PNG);
  rmSync(path.join(root, 'apps/beta/icon.svg'));
  writeProvenance(root);
  refused(root, /apps\/beta: icon\.svg: the listing names it, but the file does not exist/);
});

test('the sequence is plausible Unix seconds and at most 300 seconds ahead of this machine\'s clock', (t) => {
  const root = fixture(t);
  const now = OPTIONS.sequence;
  assert.ok(buildMarket(root, { ...OPTIONS, sequence: now + 300, now }));
  refused2(root, { ...OPTIONS, sequence: now + 301, now }, /--sequence 1795000301 is 301 seconds ahead of this machine's clock \(at most 300\)/);
  // Milliseconds, or a time after 2100, are not seconds of a commit.
  for (const sequence of [now * 1000, 4_102_444_801, 0, -1, 1.5, Number.NaN]) {
    refused2(root, { ...OPTIONS, sequence, now: 5_000_000_000 }, /--sequence must be Unix seconds: a positive whole number up to 4102444800 \(the year 2100\)/);
  }
  assert.ok(buildMarket(root, { ...OPTIONS, sequence: 4_102_444_800, now: 4_102_444_800 }));
  // Without --now, the real clock: a commit time a day ahead is refused through the command line too.
  const ahead = Math.floor(Date.now() / 1000) + 86400;
  const cli = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/market-build.ts', root, '--out', path.join(scratch(t), 'out'),
    '--commit', OPTIONS.commit, '--sequence', String(ahead)], { cwd: controlRoot, encoding: 'utf8' });
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /seconds ahead of this machine's clock/);
});

test('notice files are published as text: .txt or .md kept, no type gets .txt, anything else is refused', (t) => {
  // The names of the real catalog (YE-AppMarket), and what they become.
  const expected: Record<string, string> = {
    LICENSE: 'LICENSE.txt', 'ASSET-NOTICES.md': 'ASSET-NOTICES.md', 'LICENSE.upstream.txt': 'LICENSE.upstream.txt',
    'COPYING.GPLv2': 'COPYING.GPLv2.txt', 'COPYING.GPLv3': 'COPYING.GPLv3.txt', 'LICENSE-dashboard-icons.txt': 'LICENSE-dashboard-icons.txt',
    LICENCE: 'LICENCE.txt', 'NOTICE.TXT': 'NOTICE.TXT', COPYING: 'COPYING.txt', 'NOTICES.md': 'NOTICES.md', 'LICENSE_MIT': 'LICENSE_MIT.txt',
    'COPYING.LGPL-2-1': 'COPYING.LGPL-2-1.txt', 'LICENSE.Apache-2': 'LICENSE.Apache-2.txt',
  };
  for (const [name, output] of Object.entries(expected)) assert.equal(noticeOutputName(name), output, name);
  for (const name of ['README.md', 'licensed.txt', 'NOTICEBOARD.txt', 'icon.svg', 'youeye-app.yaml']) assert.equal(noticeOutputName(name), null, name);
  for (const name of ['LICENSE.html', 'NOTICE.svg', 'LICENSE.htm', 'COPYING.js', 'LICENSE.txt.html', 'LICENSE.md.svg', 'NOTICE.xml',
    'LICENSE.pdf', 'LICENSE.upstream', 'LICENSE..txt', 'LICENSE.a.b.txt', 'LICENSE-<b>.txt', 'LICENSE.GPL v2']) {
    assert.ok(typeof noticeOutputName(name) === 'object' && noticeOutputName(name) !== null, name);
  }

  const root = fixture(t);
  put(root, 'apps/alpha/LICENSE.html', '<script>alert(1)</script>');
  put(root, 'NOTICE.svg', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  put(root, 'apps/beta/LICENSE', 'x');
  put(root, 'apps/beta/LICENSE.txt', 'y');
  put(root, 'apps/beta/NOTICE.md', Buffer.alloc(MAX_NOTICE_BYTES + 1, 0x61));
  assert.throws(() => buildMarket(root, OPTIONS), (error: unknown) => {
    assert.ok(error instanceof MarketBuildError);
    assert.match(error.message, /apps\/alpha\/LICENSE\.html: a licence or notice file is published as text/);
    assert.match(error.message, /NOTICE\.svg: a licence or notice file is published as text/);
    assert.match(error.message, /apps\/beta\/LICENSE\.txt: published as notices\/beta\/LICENSE\.txt, the same as apps\/beta\/LICENSE/);
    assert.match(error.message, /apps\/beta\/NOTICE\.md: 1048577 bytes, more than the 1048576 allowed for a notice file/);
    return true;
  });
  rmSync(path.join(root, 'apps/alpha/LICENSE.html'));
  rmSync(path.join(root, 'NOTICE.svg'));
  rmSync(path.join(root, 'apps/beta/LICENSE.txt'));
  put(root, 'apps/beta/NOTICE.md', Buffer.alloc(MAX_NOTICE_BYTES, 0x61));
  const market = buildMarket(root, OPTIONS);
  assert.deepEqual([...market.files.keys()].filter((file) => file.startsWith('notices/') && !file.endsWith('index.html')),
    ['notices/LICENSE.txt', 'notices/alpha/ASSET-NOTICES.md', 'notices/alpha/LICENSE.upstream.txt', 'notices/beta/LICENSE.txt', 'notices/beta/NOTICE.md']);
  // Every published notice ends in .txt or .md, so any host serves it as text.
  for (const file of market.files.keys()) if (file.startsWith('notices/') && !file.endsWith('/index.html')) assert.match(file, /\.(txt|md)$/i, file);
  assert.match(market.files.get('apps/beta/index.html')!.toString(), /href="\.\.\/\.\.\/notices\/beta\/LICENSE\.txt"/);
});

test('--require-provenance refuses a catalog without asset-provenance.json', (t) => {
  const root = fixture(t);
  assert.ok(buildMarket(root, { ...OPTIONS, requireProvenance: true }));
  rmSync(path.join(root, 'asset-provenance.json'));
  assert.ok(buildMarket(root, OPTIONS));
  refused2(root, { ...OPTIONS, requireProvenance: true }, /asset-provenance\.json: missing \(--require-provenance/);
  const run = (...extra: string[]) => spawnSync(process.execPath, ['--import', 'tsx', 'scripts/market-build.ts', root, '--out', path.join(scratch(t), 'out'),
    '--commit', OPTIONS.commit, '--sequence', String(OPTIONS.sequence), ...extra], { cwd: controlRoot, encoding: 'utf8' });
  const refusedCli = run('--require-provenance');
  assert.equal(refusedCli.status, 1);
  assert.match(refusedCli.stderr, /asset-provenance\.json: missing/);
  assert.equal(run().status, 0);
});

test('provenance is checked only when the repository has asset-provenance.json', (t) => {
  const root = fixture(t);
  // With the file, a picture without a record is refused (above); without it, the market builds.
  rmSync(path.join(root, 'asset-provenance.json'));
  const market = buildMarket(root, OPTIONS);
  assert.deepEqual(verifyFiles((file) => market.files.get(file) ?? null), []);
  assert.equal(market.summary.pictures, 3);
  // A broken file is still refused when it is there.
  put(root, 'asset-provenance.json', '{"apiVersion": "something else", "assets": []}\n');
  refused(root, /asset-provenance\.json: apiVersion must be youeye\.market\/asset-provenance\/v1/);
  put(root, 'asset-provenance.json', 'not json');
  refused(root, /asset-provenance\.json: not JSON/);
});

test('catalog-level problems: native ids with app folders, unknown curation and bundle members, missing publisher', (t) => {
  const root = fixture(t);
  put(root, 'catalog.yaml', yaml({ schema: 'youeye.catalog.v1', native: ['alpha'], curation: { spotlight: { apps: ['nowhere'] } } }));
  put(root, 'bundles/pair/bundle.yaml', yaml({ schema: 'youeye.bundle.v1', id: 'pair', name: 'Pair', description: 'Both.', members: ['alpha', 'ghost'] }));
  put(root, 'store.yaml', 'name: Demo Market\n');
  assert.throws(() => buildMarket(root, OPTIONS), (error: unknown) => {
    assert.ok(error instanceof MarketBuildError);
    for (const pattern of [/native app "alpha" also has an app folder/, /curation\.spotlight names "nowhere"/,
      /bundles\/pair\/bundle\.yaml: member "ghost" is not in the catalog/, /store\.yaml: publisher must be text/]) assert.match(error.message, pattern);
    return true;
  });
});

function resolveMarketRoot(): string | null {
  const candidates = [process.env.MARKET_ROOT, path.join(controlRoot, '..', '..', 'YE-AppMarket')].filter((p): p is string => Boolean(p));
  return candidates.find((p) => existsSync(path.join(p, 'catalog.yaml'))) ?? null;
}

test('every app of the real catalog builds and reads back', (t) => {
  const marketRoot = resolveMarketRoot();
  if (!marketRoot) { t.skip('YE-AppMarket repo not checked out beside YouEye (set MARKET_ROOT)'); return; }
  const market = buildMarket(marketRoot, OPTIONS);
  assert.deepEqual(verifyFiles((file) => market.files.get(file) ?? null), []);
  const index = readMarketIndex(market.files.get(readMarketPointer(market.files.get('market.json')!).index.path)!);
  const folders = readdirSync(path.join(marketRoot, 'apps')).filter((name) => statSync(path.join(marketRoot, 'apps', name)).isDirectory()).sort();
  assert.deepEqual(index.apps.map((app) => app.id), folders);
  for (const app of index.apps) {
    const bundle = readMarketAppBundle(market.files.get(app.bundle!.path)!);
    assert.equal(bundle.manifest, readFileSync(path.join(marketRoot, 'apps', app.id, 'youeye-app.yaml'), 'utf8'), app.id);
  }
  assert.ok(market.summary.bytes.index < MARKET_LIMITS.index);
});
