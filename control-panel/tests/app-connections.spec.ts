// YE-227: the redesigned app page had no place for connections, so a suggested connection (Nextcloud → ONLYOFFICE
// Docs) could only be approved with `youeye app connect`. The page now has a Connections section (connections with
// Disconnect, suggestions with Approve and Dismiss) and the app's row in the list counts what waits for approval.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { englishInterfaceSource } from './helpers/localized-source.mjs';
import {
  approvableCount, pendingSuggestionsFor, suggestionNames, type ConnectionSuggestion,
} from '../src/components/settings-shell/app-connections-model';

const ROOT = process.env.CONTROL_PANEL_ROOT || join(import.meta.dirname, '..');
const read = (p: string) => englishInterfaceSource(readFileSync(join(ROOT, p), 'utf8'));

const suggestion = (over: Partial<ConnectionSuggestion>): ConnectionSuggestion => ({
  id: 'bridge-nextcloud-onlyoffice', type: 'bridge', fromAppId: 'nextcloud', fromAppName: 'nextcloud',
  targetAppId: 'onlyoffice', targetAppName: 'ONLYOFFICE Docs', targetInstalled: true, scope: 'service', dismissed: false,
  ...over,
});

test('both apps of a suggestion list it; dismissed, internet and other apps\' suggestions are not theirs', () => {
  const all = [
    suggestion({}),
    suggestion({ id: 'bridge-nextcloud-collabora', targetAppId: 'collabora', dismissed: true }),
    suggestion({ id: 'internet-nextcloud', type: 'internet', targetAppId: undefined }),
    suggestion({ id: 'bridge-openwebui-searxng', fromAppId: 'openwebui', targetAppId: 'searxng' }),
  ];
  assert.deepEqual(pendingSuggestionsFor('nextcloud', all).map((s) => s.id), ['bridge-nextcloud-onlyoffice']);
  assert.deepEqual(pendingSuggestionsFor('onlyoffice', all).map((s) => s.id), ['bridge-nextcloud-onlyoffice']);
  assert.deepEqual(pendingSuggestionsFor('searxng', all).map((s) => s.id), ['bridge-openwebui-searxng']);
  assert.deepEqual(pendingSuggestionsFor('immich', all), []);
});

test("the row's count is what can be approved now: a suggestion waiting for its target to be installed is not", () => {
  const all = [suggestion({}), suggestion({ id: 'bridge-nextcloud-whiteboard', targetAppId: 'whiteboard', targetInstalled: false })];
  assert.equal(approvableCount('nextcloud', all), 1);
  assert.equal(approvableCount('whiteboard', all), 0);
  assert.equal(approvableCount('nextcloud', []), 0);
});

test("a suggestion shows the installed apps' own names, the stored name only for an app that is not installed", () => {
  const installed: Record<string, string> = { nextcloud: 'Nextcloud', onlyoffice: 'ONLYOFFICE Docs' };
  const names = (id: string) => installed[id];
  // A reverse suggestion stores the consumer's id as its name.
  assert.deepEqual(suggestionNames(suggestion({}), names), { from: 'Nextcloud', to: 'ONLYOFFICE Docs' });
  // A type-based one stores the want's label for the provider.
  assert.deepEqual(suggestionNames(suggestion({ targetAppId: 'onlyoffice', targetAppName: 'Office editor' }), names).to, 'ONLYOFFICE Docs');
  assert.deepEqual(suggestionNames(suggestion({ targetAppId: 'whiteboard', targetAppName: 'Whiteboard', targetInstalled: false }), names),
    { from: 'Nextcloud', to: 'Whiteboard' });
  assert.deepEqual(suggestionNames(suggestion({ fromAppName: undefined, fromAppId: 'gone' }), names).from, 'gone');
});

test('the section approves, dismisses and disconnects through the existing APIs, admin only', () => {
  const c = read('src/components/settings-shell/app-connections.tsx');
  assert.match(c, /<AppSection id="connections" title="Connections"/);
  assert.match(c, /JSON\.stringify\(\{ action: "approve", id: s\.id \}\)/);
  assert.match(c, /JSON\.stringify\(\{ action: "dismiss", id: s\.id \}\)/);
  assert.match(c, /fetch\(`\/api\/bridges\/\$\{encodeURIComponent\(c\.id\)\}`, \{\s*method: "DELETE"/);
  // Every change carries the CSRF token the admin APIs require.
  assert.equal((c.match(/"X-CSRF-Token": csrf/g) ?? []).length, 3);
  // Disconnect asks first; approval is offered only when the target is installed.
  assert.match(c, /<ConfirmDialog/);
  assert.match(c, /\{installed && \(\s*<Button size="sm" onClick=\{\(\) => void approve\(s\)\}/);
  // A failure stays beside its row with the server's reason, and the lists are read again either way (the change
  // may have been made elsewhere, or half made).
  assert.match(c, /if \(!res\.ok\) setRowError\(\{ id: target\.id, detail: await failureReason\(res\) \}\);\s*(\/\/[^\n]*\n\s*)*await load\(\);/);
  assert.match(c, /Connections could not be loaded\. Try again later\./);
  // Each button is described by its row's title (both apps' names).
  assert.equal((c.match(/aria-describedby=\{titleId\(/g) ?? []).length, 3);

  const page = read('src/components/settings-shell/apps-client.tsx');
  assert.match(page, /\{isAdmin && isUserApp && \(\s*<AppConnections/);
  // The old Network tab (?tab=network) now scrolls to the section.
  assert.match(page, /network: "connections",/);
  // The list row names the waiting count.
  assert.match(page, /approvableCount\(app\.id, suggestions\)/);
  // Only administrators decide suggestions; anyone else does not ask for them.
  assert.match(page, /if \(!isAdmin\) return;\s*fetch\("\/api\/suggestions"/);
});

test('the orphaned embed panel is gone', () => {
  assert.equal(existsSync(join(ROOT, 'src/app/embed/app-network')), false);
});
