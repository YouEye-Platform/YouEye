import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const repoRoot = process.env.CONTROL_PANEL_ROOT || join(import.meta.dirname, '..');

function read(path) {
  return readFileSync(join(repoRoot, path), 'utf8');
}

test('scoped app-token Caddy grants deny unapproved app-token fallthrough', () => {
  const caddy = read('src/lib/caddy/client.ts');
  const manager = read('src/lib/bridges/manager.ts');
  const repairRoute = read('src/app/api/setup/control-routes/route.ts');

  assert.match(caddy, /SCOPED_APP_GRANT_DENY_ROUTE_ID = 'app-grant-token-deny'/);
  assert.match(caddy, /header:\s*\{\s*'X-Youeye-App-Token': \['\*'\]/);
  assert.match(caddy, /handler: 'static_response'/);
  assert.match(caddy, /status_code: 403/);
  assert.match(caddy, /terminal: true/);
  assert.match(caddy, /server\.routes = upsertScopedAppGrantDenyRoute\(server\.routes\)/);
  assert.match(caddy, /export async function ensureScopedAppGrantDenyRoute/);

  const grantInsertIndex = caddy.indexOf('server.routes.splice(stripIndex, 0, grantRoute)');
  const denyInsertIndex = caddy.indexOf('server.routes = upsertScopedAppGrantDenyRoute(server.routes)');
  const setConfigIndex = caddy.indexOf('await setConfig(cfg);', denyInsertIndex);
  assert.ok(grantInsertIndex > -1);
  assert.ok(denyInsertIndex > grantInsertIndex);
  assert.ok(setConfigIndex > denyInsertIndex);

  assert.match(repairRoute, /ensureScopedAppGrantDenyRoute/);
  assert.match(repairRoute, /app-grant-token-deny/);

  assert.match(manager, /injectCaddyRootCA/);
  const addGrantIndex = manager.indexOf('await addScopedAppGrantRoute');
  const injectCaIndex = manager.indexOf('await injectCaddyRootCA(fromContainer)');
  assert.ok(addGrantIndex > -1);
  assert.ok(injectCaIndex > addGrantIndex);
});
