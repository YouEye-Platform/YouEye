// my.youeye.me (sites/my/): the link checks and the targets of "Open my YouEye". The page logic is
// plain browser JavaScript; its pure functions are imported here (the page part needs `document`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import * as my from '../../sites/my/my.js';

const controlRoot = process.env.CONTROL_PANEL_ROOT ?? path.resolve(__dirname, '..');
const siteRoot = path.join(controlRoot, '..', 'sites', 'my');
const ORIGIN = 'https://my-box.ui.bingo';

test('market and app links: https URLs without credentials, control characters, backslashes or spaces, at most 1,500 characters', () => {
  const ok = (search: string) => my.parseLink('add', search);
  assert.deepEqual(ok('?market=https%3A%2F%2Fmarket.example.org%2F'), { ok: true, kind: 'market', value: 'https://market.example.org/' });
  assert.deepEqual(ok('?market=https://market.example.org/x/'), { ok: true, kind: 'market', value: 'https://market.example.org/x/' });
  assert.deepEqual(ok('?app=https://example.org/a/youeye-app.yaml?ref=main'), { ok: true, kind: 'app', value: 'https://example.org/a/youeye-app.yaml?ref=main' });
  assert.deepEqual(ok('?market=https://EXAMPLE.org'), { ok: true, kind: 'market', value: 'https://example.org/' }, 'shown and forwarded in parsed form');
  assert.deepEqual(ok('?market=https://xn--80ak6aa92e.com/'), { ok: true, kind: 'market', value: 'https://xn--80ak6aa92e.com/' });
  assert.equal(ok('?market=https://аррӏе.com/').value, 'https://xn--80ak6aa92e.com/', 'look-alike names are shown as punycode');

  const refused: Array<[string, RegExp]> = [
    ['', /names no market and no app/],
    ['?market=', /is missing/],
    ['?market=http://market.example.org/', /must start with https/],
    ['?market=javascript:alert(1)', /must start with https/],
    ['?market=data:text/html,x', /must start with https/],
    ['?app=file:///etc/passwd', /must start with https/],
    ['?market=//market.example.org/', /is not a URL/],
    ['?market=market.example.org', /is not a URL/],
    ['?market=https://user:pw@market.example.org/', /user name or password/],
    ['?market=https://user@market.example.org/', /user name or password/],
    ['?market=https://market.example.org/?x=1', /query or a fragment/],
    ['?market=https://market.example.org/#x', /query or a fragment/],
    ['?market=https://market.example.org%5C@evil.example/', /backslash/],
    ['?market=https://market.example.org/%0Aevil', /control characters/],
    ['?market=https://market.example.org/%09', /control characters/],
    ['?market=https://market.example.org/%C2%85', /control characters/],
    ['?market=https://market.example.org/a%20b', /spaces/],
    ['?market=https://a.example/&market=https://b.example/', /exactly one/],
    ['?market=https://a.example/&app=https://b.example/a.yaml', /exactly one/],
  ];
  for (const [search, reason] of refused) {
    const result = ok(search);
    assert.equal(result.ok, false, search);
    assert.match(result.reason, reason, search);
  }
  assert.equal(my.parseLink('home', '?market=https://a.example/').ok, false);

  // Length: 1,500 characters pass, 1,501 do not (also when parsing makes the URL longer).
  const at = (length: number) => `https://market.example.org/${'a'.repeat(length - 'https://market.example.org/'.length - 1)}/`;
  assert.equal(at(1500).length, 1500);
  assert.equal(ok(`?market=${encodeURIComponent(at(1500))}`).ok, true);
  assert.match(ok(`?market=${encodeURIComponent(at(1501))}`).reason, /longer than 1500/);
  const grows = `https://market.example.org/${'"'.repeat(600)}/`;
  assert.ok(grows.length < 1500);
  assert.match(ok(`?market=${encodeURIComponent(grows)}`).reason, /longer than 1500/, '" becomes %22 when parsed');
  // A YouEye keeps /market/add?<kind>=<encoded> across sign-in, 2,048 characters at most: an address within 1,500
  // characters whose encoded form is longer is refused here, not later on the box.
  const within = (query: number) => `https://a.example/m.yaml?${'&'.repeat(query)}`;
  const path = (url: string) => `/market/add?app=${encodeURIComponent(url)}`;
  let longest = 0;
  while (path(within(longest + 1)).length <= my.MAX_BOX_PATH) longest += 1;
  assert.ok(within(longest + 1).length < 1500);
  assert.equal(ok(`?app=${encodeURIComponent(within(longest))}`).ok, true);
  assert.match(ok(`?app=${encodeURIComponent(within(longest + 1))}`).reason, /too long once encoded/);
});

test('app ids: [a-z][a-z0-9-], at most 32, exactly one', () => {
  assert.deepEqual(my.parseLink('app', '?id=immich'), { ok: true, kind: 'id', value: 'immich' });
  assert.deepEqual(my.parseLink('app', `?id=a${'b'.repeat(31)}`), { ok: true, kind: 'id', value: `a${'b'.repeat(31)}` });
  for (const search of ['', '?id=', `?id=a${'b'.repeat(32)}`, '?id=Immich', '?id=1app', '?id=-app', '?id=../admin', '?id=a/b', '?id=a%2Fb',
    '?id=a%3Fx', '?id=a.b', '?id=a%0A', '?id=a&id=b', '?id=%E2%80%AEapp']) {
    assert.equal(my.parseLink('app', search).ok, false, search);
  }
});

test('the box address: a host name or an https URL becomes https://<host>; http, youeye.local and odd input are refused', () => {
  const origin = (input: string) => my.normalizeBox(input);
  for (const [input, expected] of [
    ['my-box.ui.bingo', ORIGIN],
    ['  My-Box.UI.bingo  ', ORIGIN],
    ['https://my-box.ui.bingo', ORIGIN],
    ['https://my-box.ui.bingo/', ORIGIN],
    ['https://my-box.ui.bingo/market/immich?x=1#y', ORIGIN],
    ['HTTPS://my-box.ui.bingo', ORIGIN],
    ['my-box.ui.bingo/market', ORIGIN],
    ['my-box.ui.bingo:8443', 'https://my-box.ui.bingo:8443'],
    ['https://my-box.ui.bingo:443', ORIGIN],
    ['cloud.example.org', 'https://cloud.example.org'],
    ['192.168.1.20', 'https://192.168.1.20'],
  ] as const) {
    assert.deepEqual(origin(input), { ok: true, origin: expected }, input);
  }
  for (const [input, reason] of [
    ['', /Enter the name/],
    ['http://my-box.ui.bingo', /https only/],
    ['youeye.local', /youeye\.local does not open the Market/],
    ['https://youeye.local', /youeye\.local does not open the Market/],
    ['box.local', /youeye\.local does not open the Market/],
    ['localhost', /full name/],
    ['my-box', /full name/],
    ['javascript:alert(1)', /Enter a name such as/],
    ['ftp://my-box.ui.bingo', /Enter a name such as/],
    ['https://user:pw@my-box.ui.bingo', /user name or password/],
    ['my box.ui.bingo', /spaces/],
    ['my-box.ui.bingo\\evil.example', /backslash/],
    ['my-box.ui.bingo\n', /^/],
    [`${'a'.repeat(300)}.example`, /too long/],
  ] as const) {
    const result = origin(input);
    if (input === 'my-box.ui.bingo\n') { assert.deepEqual(result, { ok: true, origin: ORIGIN }, 'surrounding whitespace is trimmed'); continue; }
    assert.equal(result.ok, false, input);
    assert.match(result.reason, reason, input);
  }
});

test('"Open my YouEye" goes only to /market/add?market=, /market/add?app= or /market/<id> on the saved YouEye', () => {
  assert.equal(my.targetURL(ORIGIN, { kind: 'market', value: 'https://market.example.org/x/' }),
    'https://my-box.ui.bingo/market/add?market=https%3A%2F%2Fmarket.example.org%2Fx%2F');
  assert.equal(my.targetURL(ORIGIN, { kind: 'app', value: 'https://example.org/a.yaml?ref=main&x=1' }),
    'https://my-box.ui.bingo/market/add?app=https%3A%2F%2Fexample.org%2Fa.yaml%3Fref%3Dmain%26x%3D1');
  assert.equal(my.targetURL(ORIGIN, { kind: 'id', value: 'immich' }), 'https://my-box.ui.bingo/market/immich');
  assert.equal(my.targetURL('https://my-box.ui.bingo:8443', { kind: 'id', value: 'immich' }), 'https://my-box.ui.bingo:8443/market/immich');

  // Whatever a link carries, the target keeps the saved host and one of the three paths, and the
  // value arrives at the box unchanged as the one parameter.
  const tricky = [
    'https://market.example.org/../../admin/',
    'https://market.example.org/%2e%2e/%2e%2e/admin/',
    'https://evil.example/@my-box.ui.bingo/',
    'https://my-box.ui.bingo.evil.example/',
    'https://market.example.org/&app=https://evil.example/a.yaml',
    'https://market.example.org/%26market%3Dx/',
    'https://market.example.org/;/?/',
    `https://market.example.org/${'x'.repeat(1400)}/`,
  ];
  for (const search of tricky.map((value) => `?market=${encodeURIComponent(value)}`).concat(['?market=https://a.example/%23/', '?app=https://a.example/a.yaml?market=https://evil.example/'])) {
    const link = my.parseLink('add', search);
    if (!link.ok) continue;
    const target = new URL(my.targetURL(ORIGIN, link));
    assert.equal(target.origin, ORIGIN, search);
    assert.equal(target.pathname, '/market/add', search);
    assert.deepEqual([...target.searchParams.keys()], [link.kind], search);
    assert.equal(target.searchParams.get(link.kind), link.value, search);
    assert.equal(target.hash, '', search);
  }
  assert.equal(my.parseLink('add', `?market=${encodeURIComponent(tricky[0])}`).value, 'https://market.example.org/admin/');

  // Refused: an origin that is not a normalised https origin, a value that is not a valid link.
  for (const origin of ['http://my-box.ui.bingo', 'https://my-box.ui.bingo/', 'https://my-box.ui.bingo/x', 'javascript:alert(1)', 'my-box.ui.bingo', 'https://youeye.local']) {
    assert.throws(() => my.targetURL(origin, { kind: 'id', value: 'immich' }), origin);
  }
  assert.throws(() => my.targetURL(ORIGIN, { kind: 'id', value: '../admin' }));
  assert.throws(() => my.targetURL(ORIGIN, { kind: 'market', value: 'http://x.example/' }));
  assert.throws(() => my.targetURL(ORIGIN, { kind: 'market', value: 'https://x.example/?a' }));
  assert.throws(() => my.targetURL(ORIGIN, { kind: 'other', value: 'x' }));
});

test('the link builder and the badge snippet', () => {
  assert.deepEqual(my.buildLink('market', ' https://example.org/market '), { ok: true, link: 'https://my.youeye.me/add?market=https%3A%2F%2Fexample.org%2Fmarket%2F' });
  assert.deepEqual(my.buildLink('market', 'https://example.org/market/market.json'), { ok: true, link: 'https://my.youeye.me/add?market=https%3A%2F%2Fexample.org%2Fmarket%2F' });
  assert.deepEqual(my.buildLink('app', 'https://example.org/a/youeye-app.yaml'), { ok: true, link: 'https://my.youeye.me/add?app=https%3A%2F%2Fexample.org%2Fa%2Fyoueye-app.yaml' });
  assert.deepEqual(my.buildLink('id', 'immich'), { ok: true, link: 'https://my.youeye.me/app?id=immich' });
  assert.equal(my.buildLink('id', 'Immich').ok, false);
  assert.equal(my.buildLink('market', 'http://example.org/').ok, false);
  assert.equal(my.buildLink('market', 'https://example.org/?a=1').ok, false);
  // The builder's link is a link this page accepts.
  const built = new URL(my.buildLink('market', 'https://example.org/market').link);
  assert.deepEqual(my.parseLink('add', built.search), { ok: true, kind: 'market', value: 'https://example.org/market/' });
  assert.equal(my.badgeSnippet('https://my.youeye.me/add?market=a&b="c"'),
    '<a href="https://my.youeye.me/add?market=a&amp;b=&quot;c&quot;"><img src="https://my.youeye.me/badge.svg" alt="Add to YouEye" width="180" height="40"></a>');
  assert.equal(my.describe({ kind: 'id', value: 'immich' }), 'This shows the app “immich” in your YouEye’s Market.');
});

test('the files: a strict content policy, no other host, relative references that exist', () => {
  const files = (dir: string, prefix = ''): string[] => readdirSync(path.join(dir, prefix)).sort().flatMap((name) => {
    const rel = prefix ? `${prefix}/${name}` : name;
    return statSync(path.join(dir, rel)).isDirectory() ? files(dir, rel) : [rel];
  });
  const all = files(siteRoot);
  assert.deepEqual(all, ['404.html', 'add/index.html', 'app/index.html', 'badge.svg', 'index.html', 'my.js', 'site.css', 'youeye.svg']);
  for (const file of all.filter((name) => name.endsWith('.html'))) {
    const text = readFileSync(path.join(siteRoot, file), 'utf8');
    assert.match(text, /<html lang="en">/, file);
    assert.match(text, /<meta http-equiv="Content-Security-Policy" content="default-src 'none'; (script-src 'self'; )?style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'">/, file);
    assert.match(text, /<meta name="referrer" content="no-referrer">/, file);
    assert.doesNotMatch(text, /<script>|<script(?![^>]*\bsrc=)|\son[a-z]+=|style=/i, file);
    for (const match of text.matchAll(/\s(?:href|src)="([^"]*)"/g)) {
      const reference = match[1];
      if (/^https:\/\/youeye\.me$/.test(reference) || reference.startsWith('#')) continue;
      assert.ok(!/^[a-z]+:|^\/\//i.test(reference), `${file}: ${reference}`);
      const target = reference.startsWith('/') ? reference.slice(1) : path.posix.normalize(path.posix.join(path.posix.dirname(file), reference));
      const resolved = path.posix.normalize(target === '' || target === '.' || target.endsWith('/') ? path.posix.join(target, 'index.html') : target);
      assert.ok(all.includes(resolved), `${file}: ${reference} → ${resolved}`);
    }
  }
  // The script names no host but its own links (youeye.me, market.youeye.me, my.youeye.me) and never fetches.
  const script = readFileSync(path.join(siteRoot, 'my.js'), 'utf8');
  assert.doesNotMatch(script, /fetch\(|XMLHttpRequest|sendBeacon|WebSocket|innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function|location\.(href|assign|replace)\s*=|location\.(assign|replace)\(/);
  const hosts = new Set([...script.matchAll(/https:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)/g)].map((match) => match[1]));
  for (const host of hosts) assert.ok(['youeye.me', 'my.youeye.me', 'market.youeye.me', 'my-box.ui.bingo', 'example.org'].includes(host), host);
  const badge = readFileSync(path.join(siteRoot, 'badge.svg'), 'utf8');
  assert.match(badge, /width="180" height="40"/);
  assert.doesNotMatch(badge, /<script|href=|@import|url\(/);
});
