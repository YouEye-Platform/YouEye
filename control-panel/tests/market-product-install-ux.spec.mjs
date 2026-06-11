import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const root = process.env.CONTROL_PANEL_ROOT || join(import.meta.dirname, '..');

function read(path) {
  return readFileSync(join(root, path), 'utf8');
}

test('app detail uses a sticky action panel and keeps install progress in that panel', () => {
  const detail = read('src/app/market/[appId]/page.tsx');

  assert.match(detail, /lg:grid-cols-\[minmax\(0,1fr\)_340px\]/);
  assert.match(detail, /lg:sticky lg:top-24/);
  assert.match(detail, /Installing \$\{app\.name\}/);
  assert.match(detail, /Open \{app\.name\}/);
  assert.match(detail, /What this app uses/);
});

test('install dialog submits an immediate manifest-defaulted account-login choice', () => {
  const dialog = read('src/components/market/install-dialog.tsx');
  const types = read('src/lib/market/types.ts');
  const engine = read('src/lib/market/engine.ts');

  assert.match(dialog, /Protect this app with account login/);
  assert.match(dialog, /Default from manifest/);
  assert.match(dialog, /protectWithAccountLogin,/);
  assert.match(dialog, /type="submit"/);
  assert.match(types, /protectWithAccountLogin\?: boolean/);
  assert.match(engine, /config\.protectWithAccountLogin/);
  assert.match(engine, /resolveForwardAuth\(\s*manifest,\s*ssoEnabled \|\| nativeIdentityIntegrationPlanned,\s*config\.protectWithAccountLogin/s);
});

test('market browse separates integrations while preserving existing source variants', () => {
  const market = read('src/app/market/page.tsx');

  assert.match(market, /activeSection/);
  assert.match(market, /'apps' \| 'integrations' \| 'installed' \| 'updates'/);
  assert.match(market, /For \{target\}/);
  assert.match(market, /groupByCatalogIdentity/);
  assert.match(market, /variantHref/);
  assert.match(market, /sourceId/);
});
