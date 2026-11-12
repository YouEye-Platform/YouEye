import { englishInterfaceSource } from "./helpers/localized-source.mjs";
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const root = process.env.CONTROL_PANEL_ROOT || join(import.meta.dirname, '..');

function read(path) {
  return path.endsWith(".tsx") ? englishInterfaceSource(readFileSync(join(root, path), "utf8")) : readFileSync(join(root, path), "utf8");
}

test('the box has one release channel; no per-component channels remain', () => {
  const client = read('src/components/settings-shell/system-client.tsx');
  const apps = read('src/components/settings-shell/apps-client.tsx');
  const unified = read('src/app/api/apps/unified/route.ts');
  const service = read('src/lib/settings/service.ts');
  const core = read('src/components/settings-shell/core-system-update.tsx');
  const channel = read('src/components/settings-shell/release-channel.tsx');

  assert.match(client, /ApplianceSystemUpdate/);
  assert.match(core, /ReleaseChannelSetting/);
  assert.doesNotMatch(apps, /UpdateChannels|updateChannelKey/);
  assert.doesNotMatch(unified, /updateChannelKey/);
  assert.doesNotMatch(service, /release_source|release_channels|release_branch/);
  assert.match(channel, /\/settings\/api\/releases\/channel/);
  assert.match(channel, /never downgrades/);
  assert.equal(existsSync(join(root, 'src/components/settings-shell/update-channels.tsx')), false);
  assert.equal(existsSync(join(root, 'src/app/api/updates/channels')), false);
  assert.equal(existsSync(join(root, 'src/lib/updates/channels.ts')), false);
});

test('the Control Panel cannot choose what the host installs', () => {
  const appliance = read('src/components/settings-shell/appliance-system-update.tsx');
  assert.match(appliance, /CoreSystemUpdate/);
  assert.doesNotMatch(appliance, /repository_url|Release repository|Manifest SHA-256|system-update\/source/);
  assert.equal(existsSync(join(root, 'src/app/api/appliance/system-update')), false);
  assert.equal(existsSync(join(root, 'src/lib/appliance/system-update-source.ts')), false);
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
