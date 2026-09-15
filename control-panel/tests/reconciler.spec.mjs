import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.env.CONTROL_PANEL_ROOT || path.resolve(import.meta.dirname, '..');
const reconciler = fs.readFileSync(path.join(root, 'src/lib/market/reconciler.ts'), 'utf8');
const caddy = fs.readFileSync(path.join(root, 'src/lib/caddy/client.ts'), 'utf8');
const uninstaller = fs.readFileSync(path.join(root, 'src/lib/market/uninstaller.ts'), 'utf8');

test('reconcile recreates and verifies missing single and multi-entrance Caddy routes', () => {
  assert.match(reconciler, /await recreateRoutes\(meta\)/);
  assert.match(reconciler, /Caddy route did not persist after reconcile/);
  assert.match(reconciler, /await addRoute\(/);
  assert.match(reconciler, /await addAppRoutes\(/);
});

test('multi-entrance route writes fail loudly', () => {
  const block = caddy.slice(caddy.indexOf('export async function addAppRoutes'), caddy.indexOf('export async function removeAppRoutes'));
  assert.doesNotMatch(block, /catch \(err\)/);
  assert.match(block, /throw new Error\('Caddy has no HTTP server/);
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
  assert.match(uninstaller, /import \{ execCommand, incusRequest \} from '\.\.\/incus\/server'/);
  assert.match(uninstaller, /\/usr\/local\/bin\/pg_isready/);
});
