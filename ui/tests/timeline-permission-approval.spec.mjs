import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const uiRoot = process.env.UI_ROOT || join(import.meta.dirname, '..');

function read(path) {
  return readFileSync(join(uiRoot, path), 'utf8');
}

test('timeline writes require explicit permission approval', () => {
  const route = read('src/app/api/v1/timeline/route.ts');
  const approvalHelper = read('src/lib/permissions/approval.ts');

  assert.doesNotMatch(route, /NATIVE_APP_IDS/);
  assert.doesNotMatch(route, /grantPermission/);
  assert.match(route, /buildPermissionApproval\(appId, \["timeline:write"\], "persistent", request\)/);
  assert.match(approvalHelper, /approval_required: true/);
  assert.match(route, /Permission denied: timeline:write required/);

  const checkIndex = route.indexOf('await checkPermission');
  const denyIndex = route.indexOf('Permission denied: timeline:write required');
  const bodyIndex = route.indexOf('const body = await request.json()');
  assert.ok(checkIndex > -1 && denyIndex > checkIndex);
  assert.ok(bodyIndex > denyIndex);
});
