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

test('completed install history does not hide reinstall after uninstall', () => {
  const detail = read('src/app/market/[appId]/page.tsx');

  assert.match(detail, /data\.done && !data\.error/);
  assert.match(detail, /\/api\/market\/status\?app=/);
  assert.match(detail, /currentStatus\.status === 'not-installed'/);
});

test('install progress remains scoped to the current app across navigation and async polling', () => {
  const detail = read('src/app/market/[appId]/page.tsx');

  assert.match(detail, /setInstallOperationAppId\(null\)/);
  assert.match(detail, /data\.appId !== expectedAppId \|\| expectedAppId !== appId/);
  assert.match(detail, /data\.appId !== appId/);
  assert.match(detail, /return \(\) => \{ active = false; \}/);
  assert.match(detail, /installOperationAppId === appId && installEvents\.length > 0/);
  assert.match(detail, /!!installError \|\| latestInstallEvent\?\.status === 'error'/);
  assert.match(detail, /message: 'Preparing installation\.\.\.'/);
  assert.match(detail, /if \(data\.events\?\.length\) setInstallEvents\(data\.events\)/);
  assert.match(detail, /installOperationAppId === appId && !installDone\s*\? 'Installing'/);
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
  // The account-login gate is driven by config.protectWithAccountLogin. The engine
  // was refactored to name the derived inputs (hasOwnAccountLogin = ssoEnabled ||
  // nativeIdentityIntegrationPlanned; forwardAuthChoice = protectWithAccountLogin
  // when the app has no own login) — assert that contract via those pieces.
  assert.match(engine, /const hasOwnAccountLogin = ssoEnabled \|\| nativeIdentityIntegrationPlanned/);
  assert.match(engine, /config\.protectWithAccountLogin/);
  assert.match(engine, /resolveForwardAuth\(\s*manifest,\s*hasOwnAccountLogin,\s*forwardAuthChoice/s);
});

test('market browse separates integrations while preserving existing source variants', () => {
  const market = read('src/app/market/page.tsx');

  // Section state drives Apps / Installed / Updates / Integrations separation.
  assert.match(market, /const \[section, setSection\]/);
  assert.match(market, /'apps' \| 'installed' \| 'updates' \| 'integrations'/);
  assert.match(market, /Integrations/);
  // Source variants are preserved: rows link to the app + its source.
  assert.match(market, /variantHref/);
  assert.match(market, /sourceId/);
});
