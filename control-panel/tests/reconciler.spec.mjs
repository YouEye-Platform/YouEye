import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.env.CONTROL_PANEL_ROOT || path.resolve(import.meta.dirname, '..');
const reconciler = fs.readFileSync(path.join(root, 'src/lib/market/reconciler.ts'), 'utf8');
const caddy = fs.readFileSync(path.join(root, 'src/lib/caddy/client.ts'), 'utf8');
const uninstaller = fs.readFileSync(path.join(root, 'src/lib/market/uninstaller.ts'), 'utf8');

test('reconcile recreates and verifies missing Caddy routes', () => {
  assert.match(reconciler, /repair: \(\) => recreateRoutes\(meta\)/);
  assert.match(reconciler, /Caddy route did not persist after reconcile/);
  assert.match(reconciler, /await addRoute\(/);
});

test('app routes are removed by exact hostname or recorded upstream, never by an app-id prefix', () => {
  assert.doesNotMatch(caddy, /removeAppRoutes|addAppRoutes/);
  for (const source of [reconciler, uninstaller]) {
    assert.doesNotMatch(source, /startsWith\(`app-/);
    assert.doesNotMatch(source, /removeAppRoutes/);
  }
  assert.match(reconciler, /deleteOwnedInstance\(name, owner\)/);
  assert.match(uninstaller, /deleteOwnedInstance\(c\.containerName, owner\)/);
});

test('scan cleanup covers runtime, routes, metadata, app state, UI, database, and storage with verification', () => {
  for (const marker of ['instance:', 'routes:', 'network:', 'bridges:', 'installed-apps:', 'metadata:', 'ui-drawer:', 'database:', 'storage:']) {
    assert.match(reconciler, new RegExp(marker));
  }
  assert.match(reconciler, /verify-instance:/);
  assert.match(reconciler, /verify-routes:/);
  assert.match(reconciler, /verify-ui-drawer:/);
  assert.match(uninstaller, /cleanupAppByScan\(\s*appId,\s*\{/);
});

test('UI bridge operations refuse to downgrade to unauthenticated requests', () => {
  assert.match(reconciler, /refusing an unauthenticated UI request/);
  assert.doesNotMatch(reconciler, /bridgeToken \? \{ 'X-UI-Bridge-Token'/);
});

test('reconcile database operations do not pass SQL through a shell parser', () => {
  assert.match(reconciler, /execCommand/);
  assert.doesNotMatch(reconciler, /execShell/);
  assert.match(reconciler, /\/usr\/local\/bin\/psql/);
  assert.match(uninstaller, /import \{ execCommand \} from '\.\.\/incus\/server'/);
  assert.match(uninstaller, /\/usr\/local\/bin\/pg_isready/);
});
