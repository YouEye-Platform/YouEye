import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const repoRoot = process.env.CONTROL_PANEL_ROOT || join(import.meta.dirname, '..');
const read = (p) => readFileSync(join(repoRoot, p), 'utf8');

test('/api/domain returns the authoritative settings domain before Caddy inference', () => {
  const source = read('src/app/api/domain/route.ts');

  assert.match(source, /settingsService\.getRaw\(\)/);
  assert.match(source, /domain = typeof config\.domain === 'string'/);
  assert.match(source, /const caddyDomain = await getConfiguredDomain\(\)/);
  assert.match(source, /domain: domain \|\| caddyDomain \|\| null/);

  const settingsRead = source.indexOf('settingsService.getRaw()');
  const caddyRead = source.indexOf('getConfiguredDomain()');
  assert.ok(settingsRead > -1 && caddyRead > -1 && settingsRead < caddyRead);
});

test('Caddy configured-domain helper preserves leased subdomain domains', () => {
  const source = read('src/lib/caddy/client.ts');
  const fnStart = source.indexOf('export async function getConfiguredDomain');
  const fnEnd = source.indexOf('export async function setDefaultRoute', fnStart);
  const helper = source.slice(fnStart, fnEnd);
  const policyBranch = helper.slice(0, helper.indexOf('// Try to extract from existing routes'));

  assert.match(policyBranch, /return subject/);
  assert.match(policyBranch, /must not collapse to ui\.bingo/);
  assert.doesNotMatch(policyBranch, /parts\.slice\(-2\)\.join\('\.'\)/);
});

test('catalog installs canonicalize browser-supplied domains server-side', () => {
  const source = read('src/app/api/market/install/route.ts');

  assert.match(source, /import \{ settingsService \} from '@\/lib\/settings'/);
  assert.match(source, /async function canonicalPlatformDomain\(\)/);
  assert.match(source, /config\.domain = canonicalDomain/);
  assert.match(source, /Ignoring client-supplied install domain/);
  assert.match(source, /Subdomain must be a single DNS label/);
  assert.match(source, /\^\[a-z0-9\]\(\[a-z0-9-\]\{0,61\}\[a-z0-9\]\)\?\$/);
  assert.doesNotMatch(source, /Missing required fields: appId, subdomain, domain/);
});

test('URL installs canonicalize browser-supplied domains server-side', () => {
  const source = read('src/app/api/market/install-url/route.ts');

  assert.match(source, /import \{ settingsService \} from '@\/lib\/settings'/);
  assert.match(source, /async function canonicalPlatformDomain\(\)/);
  assert.match(source, /domain = await canonicalPlatformDomain\(\)/);
  assert.match(source, /Ignoring client-supplied URL install domain/);
  assert.match(source, /Subdomain must be a single DNS label/);
  assert.match(source, /body\.manifestUrl \?\? body\.url/);
  assert.match(source, /manifest\.metadata\.defaultSubdomain\.trim\(\)\.toLowerCase\(\)/);
  assert.doesNotMatch(source, /Missing required fields: manifestUrl, subdomain, domain/);
});
