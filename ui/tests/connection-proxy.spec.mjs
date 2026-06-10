import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const uiRoot = process.env.UI_ROOT || join(import.meta.dirname, '..');

function read(path) {
  return readFileSync(join(uiRoot, path), 'utf8');
}

test('app connection proxy validates app token and enforces approved route scope', () => {
  const route = read('src/app/api/apps/v1/proxy/[targetAppId]/[...path]/route.ts');
  const middleware = read('src/middleware.ts');
  const bridge = read('src/app/api/ui-bridge/app-connections/route.ts');
  const discovery = read('src/app/api/v1/my-connections/route.ts');

  assert.match(route, /validateAppToken\(request\)/);
  assert.match(route, /App token does not match X-YouEye-App/);
  assert.match(route, /allowedByMethod/);
  assert.match(route, /allowedByPath/);
  assert.match(route, /resolveServiceAuth\(request\)/);
  assert.match(route, /Connection proxy requires current user identity/);
  assert.match(route, /checkPermission\(serviceUser\.id, sourceAppId, permission\)/);
  assert.match(route, /Connection to "\$\{targetAppId\}" is not approved or active/);
  assert.match(route, /X-YouEye-App-Token/);
  assert.match(route, /fetch\(upstreamUrl, init\)/);
  assert.match(middleware, /"\/api\/apps\/v1\/proxy"/);
  assert.match(bridge, /available: available \?\? \[\]/);
  assert.match(discovery, /resolveServiceAuth\(request\)/);
  assert.match(discovery, /checkPermission\(serviceUser\.id, appId, permission\)/);
  assert.match(discovery, /available,/);
});
