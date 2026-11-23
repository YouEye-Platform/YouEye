import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

// Old Settings addresses keep working after the Settings redesign (YE-128): bookmarks, links in older docs and the
// native apps' header config (`app_settings_url` = `/settings/apps/<id>?tab=app-settings`).
const root = process.env.CONTROL_PANEL_ROOT || join(import.meta.dirname, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const page = (route: string) => read(`src/app/settings/(shell)/${route}/page.tsx`);

const REDIRECTS: [string, string][] = [
  // moved by the redesign
  ['about', '/settings/general'],
  ['about/licenses', '/settings/general/licenses'],
  ['branding', '/settings/general/title'],
  // older moves, kept
  ['containers', '/settings/system'],
  ['dns', '/settings/network?tab=dns'],
  ['apps-list', '/settings/app-management'],
  ['app-management', '/settings/apps'],
  ['accounts', '/settings'],
  ['market', '/market'],
];

for (const [from, to] of REDIRECTS) {
  test(`/settings/${from} redirects to ${to}`, () => {
    const source = page(from);
    const escaped = to.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    assert.match(source, new RegExp(`redirect\\("${escaped}"\\);`));
    // A redirect page renders nothing else.
    assert.doesNotMatch(source, /return\s*\(?\s*</);
  });
}

test('/settings/network?tab=dns opens the DNS tab', () => {
  assert.match(read('src/components/settings-shell/network-tabs.ts'), /if \(tab === "dns" \|\| tab === "routes"\) return tab;/);
  assert.match(page('network'), /<NetworkClient initialTab=\{networkTabFromParam\(tab\)\} \/>/);
});

test('/settings/apps/<id>?tab=app-settings lands on the app\'s settings section', () => {
  const client = read('src/components/settings-shell/apps-client.tsx');
  assert.match(client, /"app-settings": "settings",/);
  assert.match(client, /const requestedTab = searchParams\.get\("tab"\) as AppTab \| null;/);
  assert.match(client, /requestedTab && APP_TABS\.includes\(requestedTab\) \? TAB_SECTIONS\[requestedTab\] : null/);
  assert.match(client, /document\.getElementById\(target\)/);
  // The settings section is the app's own settings page (YE-18 B4).
  assert.match(client, /<AppSection id="settings" title=\{t\("appSettings"\)\}>\s*<AppSettingsEmbed app=\{drawerApp\} \/>/);
  // The section is a real anchor: AppSection renders its id.
  assert.match(read('src/components/settings-shell/app-section.tsx'), /id=\{id\}/);
});
