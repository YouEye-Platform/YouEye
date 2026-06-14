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
