import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const uiRoot = process.env.UI_ROOT || join(import.meta.dirname, '..');

function read(path) {
  return readFileSync(join(uiRoot, path), 'utf8');
}

test('my-connections requires a matching app bearer token', () => {
  const route = read('src/app/api/v1/my-connections/route.ts');

  assert.match(route, /validateAppToken\(request\)/);
  assert.match(route, /Invalid or missing app token/);
  assert.match(route, /App token does not match X-YouEye-App/);
  assert.ok(route.includes('tokenResult.appId.replace(/^ye-/, "")'));
  assert.match(route, /tokenAppId !== appId && tokenResult\.appId !== rawAppId/);

  const tokenCheckIndex = route.indexOf('const tokenResult = await validateAppToken(request)');
  const dbCheckIndex = route.indexOf('await ensureSchema()');
  assert.ok(tokenCheckIndex > -1);
  assert.ok(dbCheckIndex > tokenCheckIndex);
});
