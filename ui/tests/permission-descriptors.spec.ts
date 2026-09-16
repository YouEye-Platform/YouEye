import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const uiRoot = process.env.UI_ROOT || join(import.meta.dirname, '..');

function readUi(path: string): string {
  return readFileSync(join(uiRoot, path), 'utf8');
}

test('UI permission APIs return descriptors for user-visible grants', () => {
  const descriptors = readUi('src/lib/permissions/descriptors.ts');
  const bridge = readUi('src/app/api/ui-bridge/settings/[...path]/route.ts');
  const appApi = readUi('src/app/api/v1/permissions/app/[appId]/route.ts');
  const requestApi = readUi('src/app/api/v1/permissions/request/route.ts');

  assert.match(descriptors, /identity:youeye-id:sign-in/);
  assert.match(descriptors, /timeline:write/);
  assert.match(descriptors, /notifications:send/);
  assert.match(descriptors, /widgets:register/);
  assert.match(descriptors, /describePermission/);

  assert.match(bridge, /descriptor: describePermission\(permission\.permission\)/);
  assert.match(appApi, /descriptor: describePermission\(permission\.permission\)/);
  assert.match(requestApi, /buildPermissionApproval/);
  assert.match(requestApi, /permissions: approval\.permissions/);
});
