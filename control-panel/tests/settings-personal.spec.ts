import { englishInterfaceSource } from "./helpers/localized-source.mjs";
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

// Source-regression checks for Plan 1 Workstream C2 (Settings Personal pages).
// Run anywhere: CONTROL_PANEL_ROOT="$PWD" node --import tsx --test tests/settings-personal.spec.ts
const repoRoot = process.env.CONTROL_PANEL_ROOT || join(import.meta.dirname, '..');
const navigation = JSON.parse(readFileSync(join(repoRoot, 'messages/en.json'), 'utf8')).settingsNavigation;
function read(path: string): string {
  return path.endsWith(".tsx") ? englishInterfaceSource(readFileSync(join(repoRoot, path), "utf8")) : readFileSync(join(repoRoot, path), "utf8");
}

test('settings nav has the groups You and This server, in the redesign order', () => {
  const shell = read('src/components/settings-shell/settings-shell.tsx');
  assert.equal(navigation.you, 'You');
  assert.equal(navigation.thisServer, 'This server');
  assert.match(shell, /group\("you", userSections\)/);
  assert.match(shell, /group\("thisServer", adminSections\)/);
  const ids = [...shell.matchAll(/\{ id: "([a-z]+)", icon: /g)].map((match) => match[1]);
  assert.deepEqual(ids, ['profile', 'appearance', 'language', 'privacy', 'apps', 'ai', 'general', 'users', 'network', 'backup', 'system']);
  for (const id of ids) assert.equal(typeof navigation.hint[id], 'string', `hint for ${id}`);
  assert.equal(navigation.language, 'Language & region');
});

test('active nav item is a quiet filled row with the current-page mark, not shadcn gray bg-accent', () => {
  const shell = read('src/components/settings-shell/settings-shell.tsx');
  assert.match(shell, /"bg-muted text-foreground font-medium"/);
  assert.match(shell, /aria-current=\{active/);
  assert.doesNotMatch(shell, /bg-accent text-accent-foreground/);
});

test('C2: nav uses People (not Users) and Market is not in Settings (D9)', () => {
  const shell = read('src/components/settings-shell/settings-shell.tsx');
  assert.match(shell, /\{ id: "users", icon: Users, href: "\/settings\/users" \}/);
  assert.match(shell, /navigation\(section\.id\)/);
  assert.equal(navigation.users, 'People');
  assert.equal(navigation.market, undefined);
  assert.doesNotMatch(shell, /href:\s*"\/settings\/market"/);
});

test('phone: /settings is the list of sections; a section leads back to it, a sub-page to its section', () => {
  const shell = read('src/components/settings-shell/settings-shell.tsx');
  assert.match(shell, /className="space-y-6 md:hidden"/);
  assert.match(shell, /className="hidden w-full shrink-0 md:block md:w-52"/);
  assert.match(shell, /<Link href="\/settings" className="settings-back">/);
  assert.match(shell, /<Link href=\{parent\.href\} className="settings-back mb-2">/);
  // Role-gated: personal sections need a user context, server sections an admin.
  assert.match(shell, /hasUserContext \? \[\.\.\.USER_SECTIONS\] : \[\]/);
  assert.match(shell, /isAdmin \? \[\.\.\.ADMIN_SECTIONS\] : \[\]/);
});

test('Profile: photo and name, details, security rows; the time zone and the raw user ID are not in the form', () => {
  const profile = read('src/components/settings-shell/profile-client.tsx');
  assert.match(profile, /from "@\/components\/ui\/input"/);
  assert.match(profile, /from "@\/components\/ui\/button"/);
  assert.match(profile, /from "@\/components\/ui\/avatar"/);
  assert.match(profile, /Your account on this server/);
  assert.match(profile, />Details</);
  assert.match(profile, /ProfileIconPicker/);
  assert.match(profile, /Save changes/);
  assert.match(profile, /Sign out everywhere/);
  // The time zone is on Language & region; the profile PATCH no longer sends it.
  assert.doesNotMatch(profile, /timezone/);
  assert.match(profile, /body: JSON\.stringify\(\{ bio: local\.bio \}\)/);
  // The user ID is only inside the folded account details.
  assert.match(profile, /<details className="settings-details">[\s\S]*shownUserId[\s\S]*<\/details>/);
});

test('C2: Profile exposes real password management and no fabricated join date (pitfall #28)', () => {
  const profile = read('src/components/settings-shell/profile-client.tsx');
  assert.match(profile, /Change password/);
  assert.match(profile, /currentPassword/);
  assert.match(profile, /repeatPassword/);
  assert.doesNotMatch(profile, /joined|Joined/);
});

test('Appearance: mode first, then colour theme, then your title with the studio on its own page; no tabs', () => {
  const appearance = read('src/components/settings-shell/appearance-client.tsx');
  assert.match(appearance, /<PageHeader title="Appearance"/);
  assert.match(read('src/components/settings-shell/page-header.tsx'), /<h1[^>]*>\{title\}<\/h1>/);
  assert.ok(appearance.indexOf('id="appearance-mode"') < appearance.indexOf('id="appearance-theme"'));
  assert.match(appearance, /<ModeAndTheme \/>\s*<YourTitle \/>/);
  assert.match(appearance, /href="\/settings\/appearance\/title"/);
  assert.doesNotMatch(appearance, /TitleStudio|tabClass|setTab\(|isAdmin/);
  // The studio keeps both modes, each on its own page.
  const studio = read('src/components/settings-shell/title-studio-client.tsx');
  assert.match(studio, /uiSettingsApi\("wordart"\)/);
  assert.match(studio, /fetch\("\/api\/ui\/branding", \{\s*method: "PUT"/);
  assert.match(read('src/app/settings/(shell)/appearance/title/page.tsx'), /<TitleStudioClient mode="personal" \/>/);
});

test('Language & region: one list of languages, the time zone and derived formats; the server default left', () => {
  const lang = read('src/components/settings-shell/language-client.tsx');
  assert.match(lang, /Your language/);
  assert.match(lang, /role="radiogroup"/);
  // The time zone saves through the profile PATCH that Profile used.
  assert.match(lang, /fetch\(uiSettingsApi\("profile"\), \{\s*method: "PATCH"/);
  assert.match(lang, /body: JSON\.stringify\(\{ timezone: next \}\)/);
  assert.match(lang, /<optgroup/);
  // Formats are derived from the locale (honest), not stored as fake editable fields.
  assert.match(lang, /Intl\.DateTimeFormat/);
  assert.match(lang, /formats follow your language/);
  assert.doesNotMatch(lang, /\/api\/user\/language|isAdmin|setTab\(|function tabClass/);
});

test('C2: People page — complete user list + explicit person form + real Manage flow', () => {
  const people = read('src/components/settings-shell/users-client.tsx');
  assert.match(people, /<PageHeader title="People"/);
  assert.match(people, /Who can sign in to this server/);
  assert.match(people, /Add person/);
  assert.match(people, /First name/);
  assert.match(people, /Last name/);
  assert.match(people, /Repeat password/);
  assert.doesNotMatch(people, />Sign-in</);
  assert.doesNotMatch(people, /Emergency local access/);
  assert.doesNotMatch(people, /showSystem|isSystemUser/);
  // One grouped list of people (soft Settings rows), not a card.
  assert.match(people, /<ul className="settings-group">/);
  // Manage is a real backend flow (PATCH update, password reset, DELETE remove).
  assert.match(people, /userId\(manage\)/);
  assert.match(people, /method: "PATCH"/);
  assert.match(people, /method: "DELETE"/);
  assert.match(people, /\/password/);
  assert.doesNotMatch(people, /\b192\.168\.\d+\.\d+\b/);
});

test('C2: System page — stat row + human-named Platform + live usage + preserved update flow', () => {
  const sys = read('src/components/settings-shell/system-client.tsx');
  assert.match(sys, /<PageHeader title="System"/);
  assert.match(sys, /Your server at a glance/);
  // One grouped list of services (soft Settings rows), not a card per view of them.
  assert.match(sys, /<ul className="settings-group">/);
  assert.doesNotMatch(sys, /SystemComponents/);
  // Human service names (D4 / skill copy rule — never raw component names as titles).
  assert.match(sys, /System core/);
  assert.match(sys, /Server interface/);
  assert.match(sys, /Web gateway/);
  assert.match(sys, /Network shield/);
  // Live usage from real health data, with restart + 5s polling.
  assert.match(sys, /\/api\/health\/services/);
  assert.match(sys, /await restartServiceRequest\(slug\)/);
  assert.match(read('src/lib/health/client.ts'), /\/restart/);
  assert.match(sys, /setInterval\(loadHealth, 5000\)/);
  // The maintenance-window image-update flow is preserved (not broken by the redesign).
  assert.match(sys, /confirmMaintenanceWindow/);
  assert.match(sys, /system-updates/);
  assert.match(sys, /href: "\/settings\/system\/ssh"/);
  assert.doesNotMatch(sys, /UpdateChannels/);
});

test('C2: System page passes the installed release version, never a baked build version', () => {
  const page = read('src/app/settings/(shell)/system/page.tsx');
  assert.match(page, /release=\{\(await installedRelease\(\)\)\?\.version\}/);
  assert.doesNotMatch(page, /package\.json|controlPanelVersion|getSpineStatus/);
});
