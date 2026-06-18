import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

// Source-regression checks for Plan 1 Workstream C2 (Settings Personal pages).
// Run anywhere: CONTROL_PANEL_ROOT="$PWD" node --import tsx --test tests/settings-personal.spec.ts
const repoRoot = process.env.CONTROL_PANEL_ROOT || join(import.meta.dirname, '..');
function read(path: string): string {
  return readFileSync(join(repoRoot, path), 'utf8');
}

test('C2: settings nav has Personal + Administration section labels (Admin renamed)', () => {
  const shell = read('src/components/settings-shell/settings-shell.tsx');
  assert.match(shell, />\s*Personal\s*</);
  assert.match(shell, />\s*Administration\s*</);
  // The old "Admin" section header is gone (Administration does not match this).
  assert.doesNotMatch(shell, />\s*Admin\s*</);
});

test('C2: active nav item uses the soft-blue accent, not shadcn gray bg-accent', () => {
  const shell = read('src/components/settings-shell/settings-shell.tsx');
  assert.match(shell, /bg-primary\/10 text-primary/);
  assert.doesNotMatch(shell, /bg-accent text-accent-foreground/);
});

test('C2: nav uses People (not Users) and Market is not in Settings (D9)', () => {
  const shell = read('src/components/settings-shell/settings-shell.tsx');
  assert.match(shell, /label:\s*"People"/);
  assert.doesNotMatch(shell, /label:\s*"Market"/);
  assert.doesNotMatch(shell, /href:\s*"\/settings\/market"/);
});

test('C2: Profile is built on shadcn primitives and matches the mockup copy', () => {
  const profile = read('src/components/settings-shell/profile-client.tsx');
  assert.match(profile, /from "@\/components\/ui\/card"/);
  assert.match(profile, /from "@\/components\/ui\/input"/);
  assert.match(profile, /from "@\/components\/ui\/button"/);
  assert.match(profile, /from "@\/components\/ui\/avatar"/);
  assert.match(profile, /Your account on this server/);
  assert.match(profile, />Details</);
  assert.match(profile, /Change photo/);
  assert.match(profile, /Save changes/);
});

test('C2: Profile omits dead UI — no "Change password" button, no fabricated join date (pitfall #28)', () => {
  const profile = read('src/components/settings-shell/profile-client.tsx');
  assert.doesNotMatch(profile, /Change password/);
  assert.doesNotMatch(profile, /joined|Joined/);
});

test('C2: Appearance header is the page H1 with the mockup subtitle; WordArt picker kept (D7)', () => {
  const appearance = read('src/components/settings-shell/appearance-client.tsx');
  assert.match(appearance, /<h1 className="text-2xl font-bold tracking-tight">Appearance<\/h1>/);
  assert.match(appearance, /Make this server yours/);
  // D7: the WordArt picker remains (BrandingTabs renders it).
  assert.match(appearance, /BrandingTabs/);
});

test('C2: Language rebuilt to the two-card layout (Your language + Server default), not tabs', () => {
  const lang = read('src/components/settings-shell/language-client.tsx');
  assert.match(lang, /<h1 className="text-2xl font-bold tracking-tight">Language<\/h1>/);
  assert.match(lang, /Your language/);
  assert.match(lang, /Server default/);
  assert.match(lang, /from "@\/components\/ui\/card"/);
  // Formats are derived from the locale (honest), not stored as fake editable fields.
  assert.match(lang, /Intl\.DateTimeFormat/);
  assert.match(lang, /formats follow your language/);
  // The old tab UI is gone.
  assert.doesNotMatch(lang, /setTab\(/);
  assert.doesNotMatch(lang, /function tabClass/);
});

test('C2: People page — list reshape + Sign-in section + real Manage flow (no fake data)', () => {
  const people = read('src/components/settings-shell/users-client.tsx');
  assert.match(people, /<h1 className="text-2xl font-bold tracking-tight">People<\/h1>/);
  assert.match(people, /Who can sign in to this server/);
  assert.match(people, /Add person/);
  assert.match(people, />Sign-in</);
  assert.match(people, /Emergency local access/);
  assert.match(people, /from "@\/components\/ui\/card"/);
  // Manage is a real backend flow (PATCH update, password reset, DELETE remove).
  assert.match(people, /userId\(manage\)/);
  assert.match(people, /method: "PATCH"/);
  assert.match(people, /method: "DELETE"/);
  assert.match(people, /\/password/);
  // Emergency access IP is derived from server config — never a hardcoded LAN address.
  assert.match(people, /config\.ip/);
  assert.doesNotMatch(people, /\b192\.168\.\d+\.\d+\b/);
});

test('C2: System page — stat row + human-named Platform + live usage + preserved update flow', () => {
  const sys = read('src/components/settings-shell/system-client.tsx');
  assert.match(sys, /<h1 className="text-2xl font-bold tracking-tight">System<\/h1>/);
  assert.match(sys, /Your server at a glance/);
  assert.match(sys, /from "@\/components\/ui\/card"/);
  // Human service names (D4 / skill copy rule — never raw component names as titles).
  assert.match(sys, /System core/);
  assert.match(sys, /Server interface/);
  assert.match(sys, /Web gateway/);
  assert.match(sys, /Network shield/);
  // Live usage from real health data, with restart + 5s polling.
  assert.match(sys, /\/api\/health\/services/);
  assert.match(sys, /\/restart/);
  assert.match(sys, /setInterval\(loadHealth, 5000\)/);
  // The maintenance-window image-update flow is preserved (not broken by the redesign).
  assert.match(sys, /confirmMaintenanceWindow/);
  assert.match(sys, /system-updates/);
  // Core Update Source uses the CP-guaranteed /settings/api/* prefix (root /api/settings 404s at the domain).
  assert.match(sys, /\/settings\/api\/settings/);
  assert.doesNotMatch(sys, /fetch\("\/api\/settings"/);
});

test('C2: System page passes the running CP version for the Server interface row', () => {
  const page = read('src/app/settings/(shell)/system/page.tsx');
  assert.match(page, /cpVersion=\{pkg\.version\}/);
});
