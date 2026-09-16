import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const root = process.env.CONTROL_PANEL_ROOT || join(import.meta.dirname, '..');
const read = (path) => readFileSync(join(root, path), 'utf8');

test('onboarding is CP-owned and uses the authenticated UI bridge', () => {
  const onboarding = read('src/components/onboarding/onboarding-client.tsx');
  const caddy = read('src/lib/caddy/client.ts');
  assert.match(caddy, /'\/onboarding'/);
  assert.match(onboarding, /ProfileIconPicker/);
  assert.match(onboarding, /ui-settings\/pin\/create/);
  assert.match(onboarding, /ui-settings\/onboarding\/complete/);
  assert.doesNotMatch(onboarding, /iframe|postMessage/);
  assert.equal(existsSync(join(root, 'src/app/embed/avatar/page.tsx')), false);
});

test('profile presets, self-password change, and explicit People form are wired end-to-end', () => {
  const presets = JSON.parse(read('src/lib/profile-avatar-presets.json'));
  const picker = read('src/components/settings-shell/profile-icon-picker.tsx');
  const avatarRoute = read('src/app/api/user/avatar/route.ts');
  const artworkRoute = read('src/app/api/branding/profile-avatar-art/[id]/route.ts');
  const profile = read('src/components/settings-shell/profile-client.tsx');
  const password = read('src/app/api/user/password/route.ts');
  const people = read('src/components/settings-shell/users-client.tsx');
  const spineUsers = read('../spine/internal/cmd/user.go');
  assert.equal(presets.length, 96);
  assert.equal(new Set(presets.map((preset) => preset.id)).size, 96);
  assert.deepEqual([...new Set(presets.map((preset) => preset.category))], ['Animals', 'Nature', 'Space', 'Hobbies', 'Objects', 'Characters']);
  for (const legacyEmoji of ['🐱', '🐶', '🦊', '🐼', '🦁', '🐸', '🐧', '🦅', '🚀', '⭐', '🎵', '🎮', '📚', '🎨', '📷', '☕', '🌊', '🌙', '☀️', '🌿', '🌸', '🌋', '💎', '🔮', '⚡', '🔥', '🌈', '🎯', '👾', '🤖', '🦄', '👽']) {
    assert.ok(presets.some((preset) => preset.emoji === legacyEmoji), `missing legacy avatar ${legacyEmoji}`);
  }
  assert.match(picker, /linear-gradient\(135deg/);
  assert.match(picker, /preset\.artwork/);
  assert.match(picker, /unoptimized/);
  assert.doesNotMatch(picker, /preset\.emoji/);
  assert.doesNotMatch(picker, /LucideIcons|iconFor/);
  assert.match(avatarRoute, /linearGradient id="avatar-bg"/);
  assert.match(avatarRoute, /artworkDataUrl/);
  assert.match(avatarRoute, /data:image\/png;base64/);
  assert.doesNotMatch(avatarRoute, /font-family=.*Emoji/);
  assert.match(artworkRoute, /getProfileIconPreset/);
  assert.match(artworkRoute, /image\/png/);
  assert.match(artworkRoute, /immutable/);
  for (const preset of presets) {
    assert.equal(existsSync(join(root, 'public', 'profile-avatar-art', `${preset.id}.png`)), true, `missing artwork for ${preset.id}`);
  }
  assert.match(profile, /ProfileIconPicker/);
  assert.match(profile, /currentPassword/);
  assert.match(password, /verifyUser/);
  assert.match(password, /setPassword/);
  for (const label of ['First name', 'Last name', 'Username', 'Email', 'Password', 'Repeat password']) assert.match(people, new RegExp(label));
  for (const field of ['firstName', 'lastName', 'repeatPassword']) assert.match(spineUsers, new RegExp(`"${field}"`));
  assert.match(spineUsers, /passwords do not match/);
  assert.doesNotMatch(people, /showSystem|isSystemUser|Emergency local access/);
});

test('SSH, IP address, per-app channels, and background update polling are represented', () => {
  const system = read('src/components/settings-shell/system-client.tsx');
  const about = read('src/components/settings-shell/about-client.tsx');
  const apps = read('src/components/settings-shell/apps-client.tsx');
  assert.match(system, /settings\/system\/ssh/);
  assert.match(about, /primary_ip/);
  assert.match(apps, /updateChannelKey/);
  assert.match(apps, /hasActiveUpdate/);
  assert.doesNotMatch(system, /UpdateChannels/);
});
