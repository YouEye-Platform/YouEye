/**
 * YE-199: after an uninstall whose connection remove: steps failed, the Control Panel says which app may still list
 * the removed one, instead of leaving the warning in the API answer only.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { connectionsLeftFrom } from '../src/lib/market/uninstall-notice';

const root = process.env.CONTROL_PANEL_ROOT ?? path.resolve(import.meta.dirname, '..');

test('the uninstall answer\'s connectionsLeft is read safely, one entry per app', () => {
  assert.deepEqual(connectionsLeftFrom({ success: true, warnings: [], connectionsLeft: [] }), []);
  assert.deepEqual(connectionsLeftFrom({ success: true }), [], 'an older Control Panel sends none');
  assert.deepEqual(connectionsLeftFrom(null), []);
  assert.deepEqual(connectionsLeftFrom({ connectionsLeft: 'sonarr' }), []);
  assert.deepEqual(connectionsLeftFrom({ connectionsLeft: [
    { appId: 'sonarr', name: 'Sonarr' },
    { appId: 'sonarr', name: 'Sonarr' },
    { appId: 'radarr', name: '  ' },
    {},
    {},
    null,
    7,
  ] }), [{ appId: 'sonarr', name: 'Sonarr' }, { appId: 'radarr', name: 'radarr' }, {}]);
  const many = Array.from({ length: 30 }, (_, i) => ({ appId: `app-${i}`, name: `App ${i}` }));
  assert.equal(connectionsLeftFrom({ connectionsLeft: many }).length, 20);
});

test('the uninstall section shows the leftovers before leaving, and leaves at once without any', () => {
  const source = readFileSync(path.join(root, 'src/components/market/app-management.tsx'), 'utf8');
  assert.match(source, /const left = connectionsLeftFrom\(await res\.json\(\)\.catch\(\(\) => null\)\);\s*if \(left\.length > 0\) \{\s*setConnectionsLeft\(left\);\s*setPending\(false\);\s*return;\s*\}\s*router\.push\('\/settings\/apps'\);/);
  assert.match(source, /role="status"[\s\S]*?t\('uninstall\.done', \{ app: app\.name \}\)[\s\S]*?t\('uninstall\.leftIn', \{ app: app\.name, other: left\.name \?\? left\.appId \}\)[\s\S]*?t\('uninstall\.leftSomewhere', \{ app: app\.name \}\)[\s\S]*?t\('uninstall\.backToApps'\)/);
});

test('every catalogue has the uninstall notice with its placeholders', () => {
  for (const locale of ['en', 'de', 'es', 'fr', 'ru']) {
    const messages = JSON.parse(readFileSync(path.join(root, 'messages', `${locale}.json`), 'utf8'));
    const copy = messages.settingsApps.uninstall;
    assert.match(copy.done, /\{app\}/, `${locale} done`);
    assert.match(copy.leftIn, /\{other\}[\s\S]*\{app\}|\{app\}[\s\S]*\{other\}/, `${locale} leftIn`);
    assert.match(copy.leftSomewhere, /\{app\}/, `${locale} leftSomewhere`);
    assert.ok(copy.backToApps, `${locale} backToApps`);
    // Plain words: no connection jargon in the notice.
    assert.doesNotMatch(`${copy.leftIn} ${copy.leftSomewhere}`, /remove:|unwire|bridge|connect file/i, locale);
  }
});
