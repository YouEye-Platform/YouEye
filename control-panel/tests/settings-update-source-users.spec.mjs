import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const root = process.env.CONTROL_PANEL_ROOT || join(import.meta.dirname, '..');

function read(path) {
  return readFileSync(join(root, path), 'utf8');
}

test('Settings System owns the core update source controls', () => {
  const client = read('src/components/settings-shell/system-client.tsx');
  const service = read('src/lib/settings/service.ts');

  assert.match(client, /Core Update Source/);
  assert.match(client, /Release Branch/);
  assert.match(client, /Repo URL/);
  assert.match(client, /releaseSource: \{ repo_url: normalizedRepoUrl \}/);
  assert.match(service, /releaseSource/);
  assert.match(service, /release_source/);
});

test('Settings Users can create users as user or admin', () => {
  const client = read('src/components/settings-shell/users-client.tsx');
  const route = read('src/app/api/apps/identity/users/route.ts');

  assert.match(client, /Create User/);
  assert.match(client, /isAdmin: newRole === "admin"/);
  assert.match(client, /New User/);
  assert.match(route, /session\.isAdmin/);
  assert.match(route, /createUser/);
});

test('obsolete Settings System and Users embeds are removed', () => {
  assert.equal(existsSync(join(root, 'src/app/embed/system/page.tsx')), false);
  assert.equal(existsSync(join(root, 'src/app/embed/system/client.tsx')), false);
  assert.equal(existsSync(join(root, 'src/app/embed/users/page.tsx')), false);
  assert.equal(existsSync(join(root, 'src/app/embed/users/client.tsx')), false);
});
