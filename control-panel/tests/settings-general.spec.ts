import { englishInterfaceSource } from "./helpers/localized-source.mjs";
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

// Source-regression checks for the General page (it replaced About in the Settings redesign, 2026-11-19).
// Run: CONTROL_PANEL_ROOT="$PWD" pnpm exec node --import tsx --test tests/settings-general.spec.ts
const repoRoot = process.env.CONTROL_PANEL_ROOT || join(import.meta.dirname, '..');
const read = (p: string) => englishInterfaceSource(readFileSync(join(repoRoot, p), 'utf8'));
const has = (p: string) => existsSync(join(repoRoot, p));
const general = () => read('src/components/settings-shell/general-client.tsx');

test('General holds the server at a glance, its title, the defaults for everyone and the licences', () => {
  const c = general();
  assert.match(c, /This server/);
  assert.match(c, /IP address/);
  assert.match(c, /Uptime/);
  assert.match(c, /href="\/settings\/system"/);            // updates live on System
  assert.match(c, /href="\/settings\/general\/title"/);    // the studio is one step away, on its own page
  assert.match(c, /<DefaultLanguage \/>/);
  assert.match(c, /<UsageStatistics \/>/);
  assert.match(c, /href="\/settings\/general\/licenses"/);
});

test('General pulls real server identity, versions and reachability', () => {
  const c = general();
  assert.match(c, /\/settings\/api\/settings"/);        // siteName
  assert.match(c, /\/settings\/api\/settings\/system/);  // hostname / os / uptime / primary_ip
  assert.match(c, /\/api\/domain/);                      // domain
  assert.match(c, /\/api\/tls\/status/);                 // HTTPS state
  assert.match(c, /\/api\/ui\/branding/);                // the title preview
  assert.match(c, /primary_ip/);
  // The YouEye version is the installed release, injected by the page.
  assert.match(c, /release\?\.version/);
  assert.doesNotMatch(c, /\/api\/health\/services|cpVersion/);
});

test('General degrades honestly: Promise.allSettled, logs failures, no fabricated values (pitfalls #23/#28)', () => {
  const c = general();
  assert.match(c, /Promise\.allSettled/);
  assert.match(c, /console\.error\("\[General\]/);
  assert.doesNotMatch(c, /catch\s*\(\s*\)\s*\{\s*\}/);
});

test('the default language moved here from Language, on the same endpoints', () => {
  const c = general();
  assert.match(c, /fetch\("\/api\/setup\/config"\)/);
  assert.match(c, /fetch\("\/api\/user\/language", \{\s*method: "PATCH"/);
  assert.match(c, /Default language/);
});

test('local usage statistics moved here from Privacy: same switch, download and reset', () => {
  const c = general();
  assert.match(c, /Local usage statistics/);
  assert.match(c, /\/settings\/api\/telemetry\/settings/);
  assert.match(c, /\/settings\/api\/telemetry\/export/);
  assert.match(c, /method: "DELETE", headers: await csrfHeaders\(\)/);
  assert.match(c, /from "@\/components\/ui\/switch"/);
  const hint = JSON.parse(readFileSync(join(repoRoot, 'messages/en.json'), 'utf8')).settingsYou.general.statisticsHint;
  assert.match(hint, /kept on this server only/);
});

test('General shows the installed release (version · short tree, never a build name) and is admin-gated', () => {
  const p = read('src/app/settings/(shell)/general/page.tsx');
  assert.doesNotMatch(p, /package\.json|version\.json|controlPanelVersion/);
  assert.match(p, /await installedRelease\(\)/);
  assert.match(p, /releaseDetails\(release\)/);
  assert.match(p, /if \(!session\?\.isAdmin\) redirect\("\/settings"\)/);
});

test('the server title studio and the licences are admin-gated pages under General', () => {
  const title = read('src/app/settings/(shell)/general/title/page.tsx');
  assert.match(title, /if \(!session\?\.isAdmin\) redirect\("\/settings"\)/);
  assert.match(title, /<TitleStudioClient mode="server" \/>/);
  const l = read('src/app/settings/(shell)/general/licenses/page.tsx');
  assert.match(l, /Business Source License 1\.1/);
  assert.match(l, /session\?\.isAdmin/);
});

test('old addresses keep working', () => {
  assert.match(read('src/app/settings/(shell)/about/page.tsx'), /redirect\("\/settings\/general"\)/);
  assert.match(read('src/app/settings/(shell)/about/licenses/page.tsx'), /redirect\("\/settings\/general\/licenses"\)/);
  assert.match(read('src/app/settings/(shell)/branding/page.tsx'), /redirect\("\/settings\/general\/title"\)/);
  assert.ok(!has('src/components/settings-shell/about-client.tsx'));
});

test('No radix deps on the General surface', () => {
  assert.doesNotMatch(general(), /from ["']@radix-ui/);
});
