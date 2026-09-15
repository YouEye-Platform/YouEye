import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const root = process.env.CONTROL_PANEL_ROOT || join(import.meta.dirname, '..');

function read(path) {
  return readFileSync(join(root, path), 'utf8');
}

test('supported app detail screens own update source controls', () => {
  const client = read('src/components/settings-shell/system-client.tsx');
  const apps = read('src/components/settings-shell/apps-client.tsx');
  const unified = read('src/app/api/apps/unified/route.ts');
  const service = read('src/lib/settings/service.ts');

  assert.doesNotMatch(client, /UpdateChannels|Core update source/);
  assert.match(client, /ApplianceSystemUpdate/);
  assert.match(apps, /Update channel/);
  assert.match(apps, /componentId=\{unifiedApp\.updateChannelKey\}/);
  assert.match(unified, /updateChannelKey/);
  assert.match(service, /releaseSource/);
  assert.match(service, /release_source/);
});

test('appliance update channels retain advanced signed branch and exact source identity', () => {
  const channels = read('src/components/settings-shell/update-channels.tsx');
  const appliance = read('src/components/settings-shell/appliance-system-update.tsx');

  assert.match(channels, /Advanced/);
  assert.match(channels, /Repo URL/);
  assert.match(channels, /Release branch \/ channel/);
  assert.match(channels, /Artifact SHA-256/);
  assert.match(appliance, /Stable|stable/);
  assert.match(appliance, /Development|development/);
  assert.match(appliance, /Signed release branch/);
  assert.match(appliance, /Tracks only signed appliance releases published for this branch/);
  assert.match(appliance, /Release tag/);
  assert.match(appliance, /appliance-dev-v<version>/);
  assert.doesNotMatch(appliance, /placeholder="appliance-dev-v\d/);
  assert.match(appliance, /Manifest SHA-256/);
  assert.match(appliance, /Official GitHub/);
  assert.match(appliance, /Forgejo/);
  assert.match(appliance, /Custom HTTPS/);
  assert.match(appliance, /Alternative sources are intentionally blank by default/);
  assert.doesNotMatch(appliance, /placeholder="https:\/\//);
  assert.match(appliance, /Stable and Development metadata checks run automatically every six hours/);
  assert.match(appliance, /downloads and restarts always wait for you/);
  assert.match(appliance, /branch/);
});

test('Settings Users can create users as user or admin', () => {
  const client = read('src/components/settings-shell/users-client.tsx');
  const route = read('src/app/api/apps/identity/users/route.ts');

  // Human-outcome copy per the product-UX copy rules: the create action is
  // "Add person" (not "Create User"/"New User"); role is chosen via newRole.
  assert.match(client, /Add person/);
  assert.match(client, /isAdmin: newRole === "admin"/);
  assert.match(route, /session\.isAdmin/);
  assert.match(route, /createUser/);
});

test('obsolete Settings System and Users embeds are removed', () => {
  assert.equal(existsSync(join(root, 'src/app/embed/system/page.tsx')), false);
  assert.equal(existsSync(join(root, 'src/app/embed/system/client.tsx')), false);
  assert.equal(existsSync(join(root, 'src/app/embed/users/page.tsx')), false);
  assert.equal(existsSync(join(root, 'src/app/embed/users/client.tsx')), false);
});
