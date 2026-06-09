import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const uiRoot = process.env.UI_ROOT || join(import.meta.dirname, '..');

function read(path) {
  return readFileSync(join(uiRoot, path), 'utf8');
}

test('permission requests require explicit approval before granting', () => {
  const route = read('src/app/api/v1/permissions/request/route.ts');
  const page = read('src/app/permissions/approve/page.tsx');
  const form = read('src/app/permissions/approve/permission-approval-form.tsx');

  assert.match(route, /approved !== true/);
  assert.match(route, /approval_required: true/);
  assert.ok(route.includes('approval_url: `/permissions/approve?${params.toString()}`'));
  assert.match(route, /await grantPermission/);

  const approvalIndex = route.indexOf('if (approved !== true)');
  const grantIndex = route.indexOf('await grantPermission');
  assert.ok(approvalIndex > -1 && grantIndex > -1 && approvalIndex < grantIndex);

  assert.match(page, /YouEye permission request/);
  assert.match(page, /describePermission\(permission\)/);
  assert.match(form, /approved: true/);
  assert.match(form, /Permission granted/);
});
