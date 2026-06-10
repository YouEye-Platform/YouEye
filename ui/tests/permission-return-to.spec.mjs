import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const uiRoot = process.env.UI_ROOT || join(import.meta.dirname, '..');

function read(path) {
  return readFileSync(join(uiRoot, path), 'utf8');
}

test('permission approval carries a safe return_to back to the requesting app', () => {
  const helper = read('src/lib/permissions/approval.ts');
  const route = read('src/app/api/v1/permissions/request/route.ts');
  const page = read('src/app/permissions/approve/page.tsx');
  const form = read('src/app/permissions/approve/permission-approval-form.tsx');

  assert.match(helper, /sanitizePermissionReturnTo/);
  assert.match(helper, /params\.set\("return_to", safeReturnTo\)/);
  assert.match(route, /return_to/);
  assert.match(route, /buildPermissionApproval\(targetAppId, requested, grant_type, request, safeReturnTo\)/);
  assert.match(page, /return_to\?: string/);
  assert.match(page, /returnTo=\{params\.return_to\}/);
  assert.match(form, /window\.location\.assign\(returnTo\)/);
  assert.match(form, /return_to: returnTo/);
});
