import assert from 'node:assert/strict';
import test from 'node:test';
import { isLocalSetupHost, isPasswordSignInHost, secureCookieFor } from '../src/lib/auth/mode';
import { isMdnsSetupName, isReservedSetupDomain } from '../src/lib/auth/setup-names';

test('local setup hosts: IPv4 literals and exactly the Avahi names youeye(-N).local, any port but 3000', () => {
  const table: Array<[string, boolean]> = [
    ['192.168.1.50', true],
    ['192.168.1.50:443', true],
    ['192.168.1.50:80', true],
    ['10.0.0.2:8443', true],
    ['youeye.local', true],
    ['YouEye.local', true],
    ['youeye-2.local', true],
    ['youeye-2.local:80', true],
    ['YOUEYE-12.LOCAL', true],
    ['youeye-1234.local', true],
    ['youeye-12345.local', false],
    ['youeye-.local', false],
    ['foo.local', false],
    ['mybox.local', false],
    ['youeyes.local', false],
    ['my-youeye.local', false],
    ['192.168.1.50:3000', false],
    ['youeye.local:3000', false],
    ['a.b.local', false],
    ['.local', false],
    ['-bad.local', false],
    ['youeye.local.', false],
    ['localhost', false],
    ['localhost:3000', false],
    ['sandy-spring.ui.bingo', false],
    ['id.sandy-spring.ui.bingo', false],
    ['example.com:443', false],
    ['192.168.1.50.nip.io', false],
    ['192.168.1', false],
    ['[fe80::1]', false],
    ['192.168.1.50, evil.example', false],
    ['', false],
  ];
  for (const [host, expected] of table) assert.equal(isLocalSetupHost(host), expected, host);
});

test('password sign-in stays on the setup surface and loopback recovery', () => {
  assert.equal(isPasswordSignInHost('youeye.local'), true);
  assert.equal(isPasswordSignInHost('localhost:3000'), true);
  assert.equal(isPasswordSignInHost('127.0.0.1:3000'), true);
  assert.equal(isPasswordSignInHost('control.sandy-spring.ui.bingo'), false);
});

function request(host: string, proto?: string, url = `https://${host}/`) {
  const headers = new Headers({ host });
  if (proto) headers.set('x-forwarded-proto', proto);
  return { headers, url };
}

test('cookie Secure follows the scheme on setup hosts and is always on for named hosts', () => {
  const previous = process.env.SECURE_COOKIES;
  process.env.SECURE_COOKIES = 'true';
  try {
    assert.equal(secureCookieFor(request('youeye.local', 'http')), false);
    assert.equal(secureCookieFor(request('192.168.1.50', 'http')), false);
    assert.equal(secureCookieFor(request('youeye.local', 'https')), true);
    assert.equal(secureCookieFor(request('192.168.1.50', 'https')), true);
    assert.equal(secureCookieFor(request('youeye.local')), true, 'no proxy header: the request URL is https');
    // Named hosts keep Secure even if a header claims HTTP.
    assert.equal(secureCookieFor(request('sandy-spring.ui.bingo', 'http')), true);
    assert.equal(secureCookieFor(request('id.sandy-spring.ui.bingo', 'http', 'http://id.sandy-spring.ui.bingo/')), true);
    // Raw port 3000 is not the setup surface; loopback recovery follows its own scheme.
    assert.equal(secureCookieFor(request('192.168.1.50:3000', 'http')), true);
    assert.equal(secureCookieFor(request('localhost:3000', undefined, 'http://localhost:3000/')), false);
    assert.equal(secureCookieFor(null), true);
    process.env.SECURE_COOKIES = 'false';
    assert.equal(secureCookieFor(request('sandy-spring.ui.bingo', 'https')), false);
  } finally {
    if (previous === undefined) delete process.env.SECURE_COOKIES;
    else process.env.SECURE_COOKIES = previous;
  }
});

test('the configured platform domain is never a setup host, even when it is youeye.local', () => {
  const previous = { control: process.env.CONTROL_EXTERNAL_URL, identity: process.env.IDENTITY_URL, ui: process.env.UI_EXTERNAL_URL };
  try {
    delete process.env.UI_EXTERNAL_URL;
    delete process.env.IDENTITY_URL;
    process.env.CONTROL_EXTERNAL_URL = 'https://control.youeye.local';
    assert.equal(isLocalSetupHost('youeye.local'), false);
    assert.equal(isLocalSetupHost('youeye.local:80'), false);
    assert.equal(isLocalSetupHost('youeye-2.local'), true, 'another box name is still the setup surface');
    assert.equal(isLocalSetupHost('192.168.1.50'), true);
    delete process.env.CONTROL_EXTERNAL_URL;
    process.env.IDENTITY_URL = 'https://id.youeye-2.local';
    assert.equal(isLocalSetupHost('youeye-2.local'), false);
    assert.equal(isLocalSetupHost('youeye.local'), true);
  } finally {
    for (const [key, value] of [['CONTROL_EXTERNAL_URL', previous.control], ['IDENTITY_URL', previous.identity], ['UI_EXTERNAL_URL', previous.ui]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('youeye.local and youeye-N.local are refused as a platform domain', () => {
  for (const domain of ['youeye.local', 'YouEye.local', 'youeye.local.', ' youeye-3.local ', 'youeye-9999.local']) {
    assert.equal(isReservedSetupDomain(domain), true, domain);
  }
  for (const domain of ['youeye.home', 'mybox.local', 'box.youeye.local', 'youeye-12345.local', 'youeye.lan']) {
    assert.equal(isReservedSetupDomain(domain), false, domain);
  }
  assert.equal(isMdnsSetupName('youeye.local.'), false, 'a Host never carries the trailing dot');
});

test('setup never defaults to, or accepts, youeye.local as the platform domain', async () => {
  const { readFileSync } = await import('node:fs');
  const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  const page = read('src/app/setup/page.tsx');
  assert.match(page, /useState\('\.home'\)/);
  assert.doesNotMatch(page, /useState\('\.local'\)/);
  const address = read('src/components/setup/SetupServerName.tsx');
  assert.match(address, /const reservedDomain = tlsChoice === 'byo-provider' \? isReservedSetupDomain\(providerDomain\) : isReservedSetupDomain\(ownDomain\)/);
  assert.match(address, /\(tlsChoice === 'youeye-names' \|\| !reservedDomain\)/);
  for (const file of ['src/app/api/setup/run/route.ts', 'src/app/api/setup/reconfigure/route.ts', 'src/app/api/domain/route.ts', 'src/lib/settings/service.ts']) {
    assert.match(read(file), /isReservedSetupDomain\(/, file);
  }
});
