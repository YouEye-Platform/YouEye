import { englishInterfaceSource } from "./helpers/localized-source.mjs";
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { appFixture } from './fixtures/app-format';

const repoRoot = process.env.CONTROL_PANEL_ROOT || join(import.meta.dirname, '..');

function read(path: string): string {
  return path.endsWith(".tsx") ? englishInterfaceSource(readFileSync(join(repoRoot, path), "utf8")) : readFileSync(join(repoRoot, path), "utf8");
}

test('Market app manifests support unified app surfaces', () => {
  const schema = read('src/lib/market/app-format/schema.ts');
  const types = read('src/lib/market/types.ts');
  const catalog = read('src/lib/market/catalog.ts');

  assert.match(schema, /const Surface = xobject/);
  // 'settings-panel' was added when app settings panels adopted the unified
  // surface protocol (design skill E6).
  assert.match(schema, /kind: z\.enum\(\['widget', 'info-card', 'timeline-card', 'notification', 'settings-panel'\]\)/);
  assert.match(schema, /placement: z\.enum\(\['dashboard', 'timeline', 'notification-center', 'app-settings', 'app-detail'\]\)/);
  assert.match(schema, /surfaces: z\.array\(Surface\)\.optional\(\)/);

  assert.match(types, /export interface SurfaceSpec/);
  assert.match(types, /surfaces\?: SurfaceSpec\[\]/);
  assert.match(catalog, /surfaces: manifest\.surfaces/);
  assert.match(catalog, /hasNotificationSurface/);
  assert.match(catalog, /notifications: manifest\.capabilities\?\.notifications \|\| \(hasNotificationSurface \? true : undefined\)/);
});

test('installed app manifests are re-synced into UI from their frozen copy', () => {
  const sync = read('src/lib/market/ui-manifest-sync.ts');
  const route = read('src/app/api/market/app/[appId]/manifest-sync/route.ts');
  const detailPage = read('src/app/market/[appId]/page.tsx');

  // Installed apps are read from their frozen copy, never the live catalog.
  assert.match(sync, /readInstalledAppManifest\(appId\)/);
  assert.doesNotMatch(sync, /fetchManifestFromSource|fetchManifestReferenceFromSource/);
  assert.doesNotMatch(sync, /metadata\.manifestDigest =/);
  assert.match(sync, /readInstallMetadata/);
  assert.match(sync, /\/api\/v1\/apps\/\$\{encodeURIComponent\(appId\)\}\/manifest/);
  assert.match(sync, /X-UI-Bridge-Token/);
  assert.match(sync, /surfaces: manifest\.surfaces\?\.length \?\? 0/);

  assert.match(route, /getSession/);
  assert.match(route, /session\?\.isAdmin/);
  assert.match(route, /syncInstalledAppManifestToUI\(appId\)/);

  assert.match(detailPage, /handleSyncManifest/);
  assert.match(detailPage, /\/api\/market\/app\/\$\{encodeURIComponent\(app\.id\)\}\/manifest-sync/);
  assert.match(detailPage, /Sync manifest/);
});

test('app surfaces compile into the dashboard surface model', () => {
  const parsed = appFixture({
    id: 'surface-demo',
    image: undefined,
    source: { node: '24' },
    surfaces: [
      {
        id: 'quick-panel',
        kind: 'widget',
        placement: 'dashboard',
        name: 'Quick panel',
        embed: '/embed/widget/quick-panel',
        permissions: ['profile:read'],
        size: { default: [20, 12], min: [10, 6] },
        refresh: 300,
        settings: [{ key: 'showHints', type: 'boolean', label: 'Show hints', default: true }],
      },
      { id: 'activity-card', kind: 'timeline-card', placement: 'timeline', embed: '/embed/timeline/activity-card', triggers: ['activity'] },
      { id: 'alert', kind: 'notification', placement: 'notification-center', embed: '/embed/notification/alert' },
    ],
  });

  assert.equal(parsed.surfaces.length, 3);
  assert.equal(parsed.surfaces[0].permissions[0], 'profile:read');
  assert.equal(parsed.surfaces[0].embedPath, '/embed/widget/quick-panel');
  assert.deepEqual(parsed.surfaces[0].defaultSize, { width: 20, height: 12 });
  assert.deepEqual(parsed.surfaces[0].minSize, { width: 10, height: 6 });
  assert.equal(parsed.surfaces[0].refreshInterval, 300);
  assert.equal(parsed.surfaces[0].settingsSchema[0].default, true);
  assert.deepEqual(parsed.surfaces[1].triggers, ['activity']);
  assert.throws(() => appFixture({ image: undefined, source: { node: '24' }, surfaces: [{ id: 'x', kind: 'widget', placement: 'dashboard', embed: '/x', embedPath: '/x' }] }), /unknown field "embedPath"/);
});
