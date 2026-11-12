import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  blockedAddress, fetchUrlApp, pinnedLookup, resolvePublicHost, UrlAppError, validateAppUrl,
  type PinnedGet, type ResolvedHost, type UrlFetchDeps,
} from '../src/lib/market/url-app';
import { appYAML } from './fixtures/app-format';

test('private, loopback, link-local, CGNAT, unique-local and metadata addresses are refused', () => {
  for (const address of [
    '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '127.0.0.1', '0.0.0.0', '169.254.169.254',
    '169.254.10.1', '100.64.0.1', '100.127.255.254', '100.100.100.200', '224.0.0.1', '255.255.255.255', '198.18.0.1',
    '::', '::1', 'fc00::1', 'fd12:3456::1', 'fd00:ec2::254', 'fe80::1', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe', '64:ff9b::10.0.0.1', '2002:a00:1::1',
  ]) {
    assert.ok(blockedAddress(address), `${address} must be refused`);
  }
  for (const address of ['93.184.216.34', '1.1.1.1', '100.63.255.255', '100.128.0.1', '2606:4700::1111', '::ffff:93.184.216.34']) {
    assert.equal(blockedAddress(address), null, `${address} is public`);
  }
});

test('a host is refused when any address it resolves to is not public', async () => {
  const resolver = (addresses: string[]) => async () => addresses;
  assert.deepEqual(await resolvePublicHost('apps.example.com', resolver(['93.184.216.34'])), { address: '93.184.216.34', family: 4 });
  await assert.rejects(resolvePublicHost('apps.example.com', resolver(['93.184.216.34', '10.0.0.5'])),
    (error: unknown) => error instanceof UrlAppError && /resolves to 10\.0\.0\.5/.test(error.message));
  await assert.rejects(resolvePublicHost('rebind.example.com', resolver(['169.254.169.254'])), /cloud metadata/);
  await assert.rejects(resolvePublicHost('cgnat.example.com', resolver(['100.64.1.1'])), /CGNAT/);
  await assert.rejects(resolvePublicHost('v6.example.com', resolver(['fd00::1'])), /public server/);
  await assert.rejects(resolvePublicHost('none.example.com', resolver([])), /Could not resolve/);
  await assert.rejects(resolvePublicHost('fail.example.com', async () => { throw new Error('ENOTFOUND'); }), /Could not resolve/);
  // IP literals are checked without a lookup.
  await assert.rejects(resolvePublicHost('[::1]', async () => { throw new Error('no lookup expected'); }), /resolves to ::1/);
});

test('URL checks before resolving: HTTPS, no credentials, no internal names or literal private IPs', () => {
  assert.match(validateAppUrl('http://apps.example.com/a.yaml') ?? '', /Only HTTPS/);
  assert.match(validateAppUrl('https://user:pw@apps.example.com/a.yaml') ?? '', /credentials/);
  for (const url of ['https://localhost/a', 'https://box.local/a', 'https://x.internal/a', 'https://127.0.0.1/a',
    'https://[::1]/a', 'https://2130706433/a', 'https://0x7f.1/a', 'https://100.64.0.1/a', 'https://[fd00::1]/a']) {
    assert.match(validateAppUrl(url) ?? '', /public server/, url);
  }
  assert.equal(validateAppUrl('https://apps.example.com/youeye-app.yaml'), null);
});

function deps(addresses: Record<string, string[]>, files: Record<string, { status?: number; body?: string; type?: string }>) {
  const gets: Array<{ url: string; pinned: ResolvedHost }> = [];
  const get: PinnedGet = async (url, pinned) => {
    gets.push({ url: url.toString(), pinned });
    const file = files[url.pathname];
    if (!file) return { status: 404, contentType: 'text/plain', body: '' };
    return { status: file.status ?? 200, contentType: file.type ?? 'text/yaml', body: file.body ?? '' };
  };
  const result: UrlFetchDeps = { resolve: async (host) => addresses[host] ?? [], get };
  return { deps: result, gets };
}

test('URL installs resolve first and fetch only from the checked address', async () => {
  const good = deps({ 'apps.example.com': ['93.184.216.34'] }, { '/demo/youeye-app.yaml': { body: appYAML() } });
  const manifest = await fetchUrlApp('https://apps.example.com/demo/youeye-app.yaml', good.deps);
  assert.equal(manifest.metadata.id, 'demo');
  assert.ok(good.gets.length >= 1);
  assert.ok(good.gets.every((call) => call.pinned.address === '93.184.216.34'));

  const rebound = deps({ 'apps.example.com': ['127.0.0.1'] }, { '/demo/youeye-app.yaml': { body: appYAML() } });
  await assert.rejects(fetchUrlApp('https://apps.example.com/demo/youeye-app.yaml', rebound.deps), /public server/);
  assert.equal(rebound.gets.length, 0, 'nothing is fetched from a private address');
});

test('URL installs never follow redirects', async () => {
  const moved = deps({ 'apps.example.com': ['93.184.216.34'] }, { '/demo/youeye-app.yaml': { status: 302 } });
  await assert.rejects(fetchUrlApp('https://apps.example.com/demo/youeye-app.yaml', moved.deps), /HTTP 302 \(redirects are not followed\)/);
  assert.equal(moved.gets.length, 1);
});

test('the pinned lookup only ever answers with the checked address', () => {
  const lookup = pinnedLookup({ address: '93.184.216.34', family: 4 });
  const answers: unknown[] = [];
  (lookup as unknown as (host: string, options: object, callback: (...args: unknown[]) => void) => void)(
    'elsewhere.example', {}, (...args) => answers.push(args));
  (lookup as unknown as (host: string, options: object, callback: (...args: unknown[]) => void) => void)(
    'elsewhere.example', { all: true }, (...args) => answers.push(args));
  assert.deepEqual(answers, [[null, '93.184.216.34', 4], [null, [{ address: '93.184.216.34', family: 4 }]]]);
});
