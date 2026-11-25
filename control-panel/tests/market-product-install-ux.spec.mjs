import { englishInterfaceSource } from "./helpers/localized-source.mjs";
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const root = process.env.CONTROL_PANEL_ROOT || join(import.meta.dirname, '..');

function read(path) {
  return path.endsWith(".tsx") ? englishInterfaceSource(readFileSync(join(root, path), "utf8")) : readFileSync(join(root, path), "utf8");
}

test('app detail keeps its one action in the header and install progress right under it', () => {
  const detail = read('src/app/market/[appId]/page.tsx');

  // The action (Install, or Open + Manage in Settings) sits in the header; while this app installs, progress replaces it.
  assert.match(detail, /const action = thisInstall \? null : isInstalled \?/);
  assert.match(detail, /\{action && <div className="flex shrink-0/);
  assert.match(detail, /\{thisInstall && \(\s*<section aria-live="polite"/);
  assert.match(detail, /Installing \{(?:app\.name|String\(app\.name\))\}/);
  assert.match(detail, />Open<ExternalLink \/>/);
  assert.match(detail, /const additions = /);   // what installing it adds to this server
});

test('completed install history does not hide reinstall after uninstall', () => {
  const detail = read('src/app/market/[appId]/page.tsx');

  // A finished, successful install is never replayed when the page opens (the app's status says it is installed),
  // so an old success cannot hide Install after an uninstall; a failed one stays so its reason can be read.
  assert.match(detail, /if \(data\.done && !data\.error\) return;/);
  assert.match(detail, /\/api\/market\/status\?app=/);
  assert.match(detail, /const isInstalled = \(status\?\.status \?\? 'not-installed'\) !== 'not-installed';/);
});

test('install progress remains scoped to the current app across navigation and async polling', () => {
  const detail = read('src/app/market/[appId]/page.tsx');

  assert.match(detail, /setInstallOperationAppId\(null\)/);
  assert.match(detail, /data\.appId !== expectedAppId \|\| expectedAppId !== appId/);
  assert.match(detail, /data\.appId !== appId/);
  assert.match(detail, /return \(\) => \{ active = false; \}/);
  assert.match(detail, /installOperationAppId === appId && installEvents\.length > 0/);
  assert.match(detail, /!!installError \|\| latestInstallEvent\?\.status === 'error'/);
  assert.match(detail, /message: ['"]Preparing installation\.\.\.['"]/);
  assert.match(detail, /if \(data\.events\?\.length\) setInstallEvents\(data\.events\)/);
  assert.match(detail, /const installFailed = installOperationAppId === appId && installDone/);
});

test('install dialog submits an immediate manifest-defaulted account-login choice', () => {
  const dialog = read('src/components/market/install-dialog.tsx');
  const types = read('src/lib/market/types.ts');
  const engine = read('src/lib/market/engine.ts');

  // The YouEye ID sign-in row starts at the manifest's default and is locked where the manifest decides (YE-65's
  // meaning unchanged); since YE-154 it shows only for apps with their own login, and "Only <site> users" is the gate.
  assert.match(dialog, /useState\(\(\) => defaultAccountLogin\(app\)\)/);
  assert.match(dialog, /const accountLoginLocked = app\.supportsSSO \|\| loginIntegration\?\.required;/);
  assert.match(dialog, /appHasOwnLogin && row\('account', accountLoginLabel, accountLoginHint, protectWithAccountLogin, \(\) => toggleAccountLogin\(\), !!accountLoginLocked\)/);
  assert.match(dialog, /Sign in with YouEye ID/);
  assert.match(dialog, /installAccessFields\(app, \{ onlyUsers, youEyeSignIn: protectWithAccountLogin, existing: existingAccess \}\)/);
  assert.match(dialog, /type="submit"/);
  assert.match(types, /protectWithAccountLogin\?: boolean/);
  // The record's gate flag: apps with their own login keep the old optional flag; the others follow the switch.
  assert.match(engine, /const hasOwnAccountLogin = ssoEnabled \|\| nativeIdentityIntegrationPlanned/);
  assert.match(engine, /: !installWantsPublicAccess\(manifest, config\);/);
  assert.match(engine, /resolveForwardAuth\(\s*manifest,\s*hasOwnAccountLogin,\s*forwardAuthChoice/s);
});

test('market browse keeps other markets\' copies reachable', () => {
  const market = read('src/app/market/page.tsx');
  const parts = read('src/components/market/market-parts.tsx');

  // One card per app id (the official one first); apps added by address are all listed under their own chip, and a
  // card for another market's copy links to it with its source.
  assert.match(market, /const added = apps\.filter\(\(app\) => app\.sourceId\?\.startsWith\('direct:'\)\)/);
  assert.match(market, /key=\{`\$\{app\.id\}-\$\{app\.sourceId \?\? ''\}`\}/);
  assert.match(parts, /\?source=\$\{encodeURIComponent\(app\.sourceId\)\}/);
  // The detail page names the other markets that have the app.
  assert.match(read('src/app/market/[appId]/page.tsx'), /variants\.map\(\(variant\) =>/);
});
