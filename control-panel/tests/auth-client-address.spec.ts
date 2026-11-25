/**
 * YE-136: attempt limits key on the real client: the TCP peer (set by the launcher), and Caddy's X-Forwarded-For only
 * when the peer is Caddy. An app behind its doorway can write any header; it can neither dodge nor reset a limit.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, mock, test } from 'node:test';

import {
  clientAddressFrom,
  loadPeerRoles,
  normalizeAddress,
  PEER_HEADER,
  PEER_HEADER_FLAG,
  peerRolesFrom,
  type PeerRoles,
  requestClientAddress,
} from '../src/lib/auth/client-address';
import {
  beginSignInAttempt,
  resetSignInLimits,
  SIGN_IN_ADDRESS_ATTEMPTS,
  SIGN_IN_MAX_DELAY_SECONDS,
  signInRetryAfterSeconds,
  signInSucceeded,
} from '../src/lib/identity/sign-in-limit';

// Not the usual offset on purpose: Caddy's addresses come from Incus, never from a constant.
const CADDY = '10.80.3.7';
const HOST = '10.80.3.1';
const ROLES: PeerRoles = peerRolesFrom(
  { network: { lo: { addresses: [{ family: 'inet', address: '127.0.0.1' }] }, eth0: { addresses: [
    { family: 'inet', address: CADDY }, { family: 'inet6', address: 'fd42:1::13' }] } } },
  [
    { managed: true, config: { 'ipv4.address': `${HOST}/24`, 'ipv6.address': 'fd42:1::1/64' } },
    { managed: true, config: { 'ipv4.address': '10.76.0.1/27' } },
    { managed: false, config: { 'ipv4.address': '192.168.31.243/24' } },
  ],
);
const root = process.env.CONTROL_PANEL_ROOT ?? process.cwd();

function request(peer: string | null, headers: Record<string, string> = {}): Headers {
  return new Headers({ ...headers, ...(peer === null ? {} : { [PEER_HEADER]: peer }) });
}

beforeEach(() => {
  resetSignInLimits();
  mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-23T12:00:00Z') });
});
afterEach(() => mock.timers.reset());

test('through Caddy the client is the X-Forwarded-For entry Caddy wrote', () => {
  assert.equal(clientAddressFrom(request(CADDY, { 'x-forwarded-for': '192.168.31.192' }), ROLES), '192.168.31.192');
  assert.equal(clientAddressFrom(request(`::ffff:${CADDY}`, { 'x-forwarded-for': '192.168.31.192' }), ROLES), '192.168.31.192');
  assert.equal(clientAddressFrom(request(CADDY, { 'x-forwarded-for': '6.6.6.6, 192.168.31.192' }), ROLES), '192.168.31.192',
    'only the last entry, the one Caddy added');
  assert.equal(clientAddressFrom(request(CADDY, { 'x-forwarded-for': 'FE80::1' }), ROLES), 'fe80::1');
  // Before 0.6.17's proxy devices every client reaches Caddy as 127.0.0.1: no address limit, nobody locked out.
  assert.equal(clientAddressFrom(request(CADDY, { 'x-forwarded-for': '127.0.0.1' }), ROLES), null);
  assert.equal(clientAddressFrom(request(CADDY, {}), ROLES), null);
  assert.equal(clientAddressFrom(request(CADDY, { 'x-forwarded-for': 'unknown' }), ROLES), null);
});

test('any other peer is the client itself; its X-Forwarded-For and X-Real-IP are ignored', () => {
  const forged = { 'x-forwarded-for': '203.0.113.9', 'x-real-ip': '203.0.113.10' };
  assert.equal(clientAddressFrom(request('10.76.0.2', forged), ROLES), '10.76.0.2', "an app's own address (doorway)");
  assert.equal(clientAddressFrom(request('10.76.1.2', forged), ROLES), '10.76.1.2', 'another app');
  assert.equal(clientAddressFrom(request('10.76.0.2', { 'x-forwarded-for': '127.0.0.1' }), ROLES), '10.76.0.2',
    'an app cannot pass for loopback either');
  assert.equal(clientAddressFrom(request('10.45.18.13', { 'x-forwarded-for': '192.168.1.5' }), ROLES), '10.45.18.13',
    'the usual Caddy offset is not trusted unless Incus says it is Caddy');
});

test('peer roles come from Incus: Caddy\'s live addresses, the host\'s bridge addresses', async () => {
  assert.deepEqual([...ROLES.caddy].sort(), [CADDY, 'fd42:1::13']);
  assert.deepEqual([...ROLES.shared].sort(), ['10.76.0.1', HOST, 'fd42:1::1']);
  assert.equal(clientAddressFrom(request('fd42:1::13', { 'x-forwarded-for': '192.168.31.50' }), ROLES), '192.168.31.50');

  const paths: string[] = [];
  const get = async <T>(path: string) => {
    paths.push(path);
    if (path === '/1.0/instances/youeye-caddy/state') {
      return { type: 'sync', metadata: { network: { eth0: { addresses: [{ family: 'inet', address: '10.76.200.13' }] } } } as T };
    }
    return { type: 'sync', metadata: [{ managed: true, config: { 'ipv4.address': '10.76.200.1/24' } }] as T };
  };
  const loaded = await loadPeerRoles(get);
  assert.deepEqual(paths.sort(), ['/1.0/instances/youeye-caddy/state', '/1.0/networks?recursion=1']);
  assert.deepEqual([...loaded!.caddy], ['10.76.200.13']);
  assert.deepEqual([...loaded!.shared], ['10.76.200.1']);

  // Caddy unreadable (Incus down, no Caddy, no address): unknown, so no per-address key at all.
  assert.equal(await loadPeerRoles(async () => { throw new Error('incus down'); }), null);
  assert.equal(await loadPeerRoles(async <T>(path: string) => ({ type: path.includes('state') ? 'error' : 'sync', metadata: [] as T })), null);
  assert.equal(await loadPeerRoles(async <T>() => ({ type: 'sync', metadata: { network: { eth0: { addresses: [] } } } as T })), null);
  for (const peer of [CADDY, '10.76.0.2', HOST]) {
    assert.equal(clientAddressFrom(request(peer, { 'x-forwarded-for': '192.168.31.50' }), null), null, peer);
  }
});

test('the host\'s bridge address (every NATing app, the UI) is no client: one app cannot lock out the others', () => {
  assert.equal(clientAddressFrom(request(HOST, { 'x-forwarded-for': '192.168.31.50' }), ROLES), null);
  assert.equal(clientAddressFrom(request('fd42:1::1'), ROLES), null);
  assert.equal(clientAddressFrom(request('10.76.0.1'), ROLES), null, 'an app bridge gateway too');
  // A NATing app fails 100 times across usernames through the doorway; another NATing app can still sign in.
  for (let i = 0; i < 100; i++) {
    const attempt = beginSignInAttempt(`spray-${i}`, clientAddressFrom(request(HOST, { 'x-forwarded-for': `198.51.100.${i}` }), ROLES));
    assert.equal(attempt.allowed, true, `attempt ${i + 1}`);
  }
  assert.equal(beginSignInAttempt('alice', clientAddressFrom(request(HOST), ROLES)).allowed, true);
  // The per-username slow-down still holds there (YE-149), whatever X-Forwarded-For the app sends, and never locks.
  for (let i = 0; i < 30; i++) {
    const attempt = beginSignInAttempt('owner', clientAddressFrom(request(HOST, { 'x-forwarded-for': `203.0.113.${i}` }), ROLES));
    if (!attempt.allowed) {
      assert.equal(attempt.refusal, 'wait', `attempt ${i + 1}`);
      assert.ok(signInRetryAfterSeconds(attempt) <= SIGN_IN_MAX_DELAY_SECONDS);
      mock.timers.tick(signInRetryAfterSeconds(attempt) * 1000);
    }
  }
  // One more failure (after any wait), then a new forged address must wait too: it is still the one shared source.
  const fromApp = (xff: string) => beginSignInAttempt('owner', clientAddressFrom(request(HOST, { 'x-forwarded-for': xff }), ROLES));
  const next = fromApp('198.51.100.249');
  if (!next.allowed) {
    mock.timers.tick(signInRetryAfterSeconds(next) * 1000);
    assert.equal(fromApp('198.51.100.249').allowed, true);
  }
  assert.equal(fromApp('198.51.100.250').refusal, 'wait');
  // A browser through Caddy is another source: the owner's right password works at once.
  const browser = beginSignInAttempt('owner', clientAddressFrom(request(CADDY, { 'x-forwarded-for': '192.168.31.50' }), ROLES));
  assert.equal(browser.allowed, true);
});

test('loopback and no peer are no client address; local callers are never limited by address', () => {
  for (let i = 0; i < 100; i++) {
    const address = clientAddressFrom(request(i % 2 ? '127.0.0.1' : '::ffff:127.0.0.1', { 'x-forwarded-for': '192.168.1.5' }), ROLES);
    assert.equal(beginSignInAttempt(`local-${i}`, address, 'cp-login').allowed, true);
  }
  for (const peer of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '127.0.0.53']) {
    assert.equal(clientAddressFrom(request(peer, { 'x-forwarded-for': '192.168.1.5' }), ROLES), null, peer);
  }
  assert.equal(clientAddressFrom(request(null, { 'x-forwarded-for': '192.168.1.5' }), ROLES), null, 'no launcher');
  assert.equal(clientAddressFrom(request('', { 'x-forwarded-for': '192.168.1.5' }), ROLES), null);
  assert.equal(clientAddressFrom(request('not an address'), ROLES), null);
});

test('a forged x-youeye-peer is not a peer: the launcher replaces it (node-runtime.spec.mjs); here only its value counts', () => {
  // Through Caddy the launcher writes Caddy's address; through the doorway the app's. A forged copy never reaches here.
  const viaCaddy = new Headers({ [PEER_HEADER]: CADDY, 'x-forwarded-for': '192.168.31.192' });
  assert.equal(clientAddressFrom(viaCaddy, ROLES), '192.168.31.192');
  const viaDoorway = new Headers({ [PEER_HEADER]: '10.76.0.2', 'x-forwarded-for': CADDY });
  assert.equal(clientAddressFrom(viaDoorway, ROLES), '10.76.0.2');
});

test('requestClientAddress: without the launcher the peer header is a client\'s, so it counts for nothing', async () => {
  const saved = process.env[PEER_HEADER_FLAG];
  delete process.env[PEER_HEADER_FLAG];
  try {
    assert.equal(await requestClientAddress(request(CADDY, { 'x-forwarded-for': '192.168.1.5' })), null);
    assert.equal(await requestClientAddress(request('10.76.0.2')), null);
  } finally {
    if (saved !== undefined) process.env[PEER_HEADER_FLAG] = saved;
  }
});

test('requestClientAddress: loopback and no peer need no lookup', async () => {
  process.env[PEER_HEADER_FLAG] = '1';
  assert.equal(await requestClientAddress(request('127.0.0.1', { 'x-forwarded-for': '192.168.1.5' })), null);
  assert.equal(await requestClientAddress(request(null, { 'x-forwarded-for': '192.168.1.5' })), null);
});

test('normalizeAddress', () => {
  assert.equal(normalizeAddress(' ::FFFF:192.168.1.2 '), '192.168.1.2');
  assert.equal(normalizeAddress('2001:DB8::1'), '2001:db8::1');
  assert.equal(normalizeAddress('::ffff:abcd'), '::ffff:abcd', 'only an IPv4-mapped prefix is stripped');
  for (const bad of ['', 'unknown', 'a'.repeat(50), '1.2.3.4; drop', '<script>', 'abc']) assert.equal(normalizeAddress(bad), null, bad);
});

test("an app's forged X-Forwarded-For neither dodges nor resets YouEye ID's per-address limit", () => {
  const app = '10.76.0.2';
  for (let i = 0; i < SIGN_IN_ADDRESS_ATTEMPTS; i++) {
    const address = clientAddressFrom(request(app, { 'x-forwarded-for': `198.51.100.${i}` }), ROLES);
    assert.equal(beginSignInAttempt(`spray-${i}`, address).allowed, true, `failure ${i + 1}`);
  }
  // A new forged address, or a forged Caddy-like chain, or one of its own accounts' successes: still the app.
  const forgedNew = clientAddressFrom(request(app, { 'x-forwarded-for': '198.51.100.250' }), ROLES);
  assert.equal(beginSignInAttempt('spray-new', forgedNew).allowed, false);
  const chain = clientAddressFrom(request(app, { 'x-forwarded-for': `1.1.1.1, ${CADDY}` }), ROLES);
  assert.equal(beginSignInAttempt('spray-new', chain).allowed, false);
  const ownAccount = beginSignInAttempt('mine', clientAddressFrom(request(app, { 'x-forwarded-for': '198.51.100.251' }), ROLES));
  assert.equal(ownAccount.allowed, false, 'a success cannot even be tried to refund the count');
  signInSucceeded(ownAccount);
  assert.equal(beginSignInAttempt('spray-new', app).allowed, false);

  // Browsers through Caddy, and another app, are not affected.
  const browser = clientAddressFrom(request(CADDY, { 'x-forwarded-for': app }), ROLES);
  assert.equal(browser, app, 'a LAN client whose address happens to match');
  assert.equal(beginSignInAttempt('owner', clientAddressFrom(request(CADDY, { 'x-forwarded-for': '192.168.31.192' }), ROLES)).allowed, true);
  assert.equal(beginSignInAttempt('owner', clientAddressFrom(request('10.76.1.2'), ROLES)).allowed, true);
});

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

test('only client-address.ts reads a client address header; the limited routes use it', () => {
  const readers = sources(join(root, 'src'))
    .filter((path) => /['"]x-(forwarded-for|real-ip)['"]/i.test(readFileSync(path, 'utf8')))
    .map((path) => relative(root, path));
  assert.deepEqual(readers, ['src/lib/auth/client-address.ts']);

  const read = (path: string) => readFileSync(join(root, path), 'utf8');
  const login = read('src/app/api/auth/login/route.ts');
  assert.match(login, /beginSignInAttempt\(username, ip, 'cp-login'\)/);
  assert.match(login, /const ip = await requestClientAddress\(request\.headers\);/);
  assert.match(login, /signInSucceeded\(attempt\);/);
  assert.doesNotMatch(login, /login:\$\{ip\}/, 'the old per-address-only key, shared by every client without a header');

  const claim = read('src/app/api/appliance/claim/route.ts');
  assert.match(claim, /beginSignInAttempt\(\n\s+typeof body\.username === 'string' \? body\.username : '',\n\s+await requestClientAddress\(request\.headers\),\n\s+'appliance-claim',\n\s+\)/);
  assert.equal(claim.match(/signInNotCounted\(attempt\);/g)?.length, 7, 'form errors, 409s and failures count against nothing');
  assert.match(claim, /signInSucceeded\(attempt\);/);

  const reset = read('src/app/api/auth/reset-owner/route.ts');
  assert.match(reset, /beginSignInAttempt\(OWNER, await requestClientAddress\(request\.headers\), 'owner-reset'\)/);
  assert.match(reset, /if \(result\.status === 200\) \{\n\s+signInSucceeded\(attempt\);/);
  assert.match(reset, /if \(result\.code !== 'invalid_code'\) signInNotCounted\(attempt\);/);

  const launcher = readFileSync(join(root, 'scripts/bundle-node-runtime.mjs'), 'utf8');
  assert.match(launcher, /request\.headers\['x-youeye-peer'\] = \(request\.socket && request\.socket\.remoteAddress\) \|\| '';/);
  assert.match(launcher, /process\.env\.YOUEYE_PEER_HEADER = '1';/);
});
