import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

// Findings of YE-128's review of the Settings and Market redesign, fixed in code.
const root = process.env.CONTROL_PANEL_ROOT || join(import.meta.dirname, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

test('the backup page names apps from their installed copy, bounded in time, never from a market read', () => {
  const route = read('src/app/api/backup/core/route.ts');
  assert.doesNotMatch(route, /fetchManifest/);
  assert.match(route, /readInstalledAppManifest\(appId\)\.catch\(\(\) => null\)/);
  assert.match(route, /const NAME_WAIT_MS = 2_000;/);
  assert.match(route, /Promise\.race\(/);
  assert.match(route, /name: \(await installedAppName\(app\.appId\)\) \|\| app\.appId/);
  // The page's poll waits for the one before it.
  const client = read('src/components/settings-shell/backup-client.tsx');
  assert.match(client, /if \(busy \|\| pollInFlight\.current\) return;/);
  assert.match(client, /\.finally\(\(\) => \{ pollInFlight\.current = false; \}\)/);
});

test('Settings → Apps: one market lookup per app, Uninstall at once and with the route\'s reasons', () => {
  const manage = read('src/components/market/app-management.tsx');
  assert.match(manage, /const marketAppRequests = new Map/);
  assert.equal(manage.match(/fetch\(`\/api\/market\/app\/\$\{encodeURIComponent\(appId\)\}`\)/g)?.length, 1);
  assert.match(manage, /const \{ app: listed \} = useMarketApp\(appId\);/);
  assert.match(manage, /const app = listed \?\? \(\{ id: appId, name: appName, supportsSSO: false \} as MarketApp\);/);
  assert.match(manage, /reasons\.join\('; '\) \|\| data\.error/);
});

test('the install dialog closes only by its own buttons; old anchors and stale errors cannot break pages', () => {
  const dialog = read('src/components/market/install-dialog.tsx');
  assert.doesNotMatch(dialog, /backdrop-blur-sm sm:items-center sm:p-4" onClick=\{onClose\}/);
  assert.match(read('src/components/settings-shell/apps-client.tsx'), /try \{ return decodeURIComponent\(window\.location\.hash\.slice\(1\)\); \} catch \{ return ""; \}/);
  assert.match(read('src/app/market/[appId]/page.tsx'), /setLoading\(true\);\s*setError\(null\);/);
});
