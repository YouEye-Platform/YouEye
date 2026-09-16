import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { AppManifestSchema } from '../src/lib/market/schema';

const repoRoot = process.env.CONTROL_PANEL_ROOT || join(import.meta.dirname, '..');

function read(path: string): string {
  return readFileSync(join(repoRoot, path), 'utf8');
}

test('Market app manifests support unified app surfaces', () => {
  const schema = read('src/lib/market/schema.ts');
  const types = read('src/lib/market/types.ts');
  const catalog = read('src/lib/market/catalog.ts');

  assert.match(schema, /SurfaceSchema/);
  // 'settings-panel' was added when app settings panels adopted the unified
  // surface protocol (design skill E6).
  assert.match(schema, /kind: z\.enum\(\['widget', 'info-card', 'timeline-card', 'notification', 'settings-panel'\]\)/);
  assert.match(schema, /placement: z\.enum\(\['dashboard', 'timeline', 'notification-center', 'app-settings', 'app-detail'\]\)/);
  assert.match(schema, /surfaces: z\.array\(SurfaceSchema\)\.optional\(\)\.default\(\[\]\)/);
  assert.match(schema, /UserPreferenceFieldSchema/);
  assert.match(schema, /preferences: z\.array\(UserPreferenceFieldSchema\)\.optional\(\)\.default\(\[\]\)/);
  assert.match(schema, /launchPreferences: z\.array\(UserPreferenceFieldSchema\)\.optional\(\)\.default\(\[\]\)/);
  assert.match(schema, /settings: AppSettingsSchema/);

  assert.match(types, /export type SurfaceSpec/);
  assert.match(types, /export type UserPreferenceField/);
  assert.match(types, /export type AppSettingsSpec/);
  assert.match(types, /surfaces\?: SurfaceSpec\[\]/);
  assert.match(catalog, /surfaces: manifest\.surfaces/);
  assert.match(catalog, /hasNotificationSurface/);
  assert.match(catalog, /notifications: manifest\.capabilities\?\.notifications \|\| \(hasNotificationSurface \? true : undefined\)/);
});

test('installed app manifests can be synced from Market into UI', () => {
  const sync = read('src/lib/market/ui-manifest-sync.ts');
  const route = read('src/app/api/market/app/[appId]/manifest-sync/route.ts');
  const detailPage = read('src/app/market/[appId]/page.tsx');

  assert.match(sync, /fetchManifestFromSource/);
  assert.match(sync, /fetchManifestReferenceFromSource/);
  assert.match(sync, /readInstallMetadata/);
  assert.match(sync, /\/api\/v1\/apps\/\$\{encodeURIComponent\(appId\)\}\/manifest/);
  assert.match(sync, /X-UI-Bridge-Token/);
  assert.match(sync, /metadata\.manifestDigest = reference\.digest/);
  assert.match(sync, /surfaces: manifest\.surfaces\?\.length \?\? 0/);

  assert.match(route, /getSession/);
  assert.match(route, /session\?\.isAdmin/);
  assert.match(route, /syncInstalledAppManifestToUI\(appId\)/);

  assert.match(detailPage, /handleSyncManifest/);
  assert.match(detailPage, /\/api\/market\/app\/\$\{encodeURIComponent\(app\.id\)\}\/manifest-sync/);
  assert.match(detailPage, /Sync manifest/);
});

test('Market schema parses dashboard, timeline, and notification surfaces', () => {
  const parsed = AppManifestSchema.parse({
    apiVersion: 'v1',
    kind: 'app',
    integration: 'basic',
    version: '1.0.0',
    metadata: {
      id: 'surface-demo',
      name: 'Surface Demo',
      description: 'Demo app',
      icon: 'square',
      category: 'demo',
      defaultSubdomain: 'surface-demo',
    },
    containers: [{
      name: 'main',
      type: 'oci',
      image: 'docker.io/library/nginx:latest',
      port: 80,
    }],
    surfaces: [
      {
        id: 'quick-panel',
        kind: 'widget',
        placement: 'dashboard',
        name: 'Quick panel',
        embedPath: '/embed/widget/quick-panel',
        permissions: ['profile:read'],
        defaultSize: { width: 20, height: 12 },
      },
      {
        id: 'activity-card',
        kind: 'timeline-card',
        placement: 'timeline',
        embedPath: '/embed/timeline/activity-card',
      },
      {
        id: 'alert',
        kind: 'notification',
        placement: 'notification-center',
        embedPath: '/embed/notification/alert',
      },
    ],
  });

  assert.equal(parsed.surfaces.length, 3);
  assert.equal(parsed.surfaces[0].permissions[0], 'profile:read');
});

test('Market schema preserves manifest-declared first-launch preferences', () => {
  const parsed = AppManifestSchema.parse({
    apiVersion: 'v1',
    kind: 'app',
    integration: 'basic',
    version: '1.0.0',
    metadata: {
      id: 'preference-demo',
      name: 'Preference Demo',
      description: 'Demo app',
      icon: 'sliders',
      category: 'demo',
      defaultSubdomain: 'preference-demo',
    },
    containers: [{
      name: 'main',
      type: 'oci',
      image: 'docker.io/library/nginx:latest',
      port: 80,
    }],
    preferences: [
      {
        key: 'defaultNotebook',
        type: 'string',
        label: 'Default notebook',
        description: 'Notebook selected during first launch.',
        required: true,
      },
    ],
    launchPreferences: [
      {
        key: 'digestFrequency',
        type: 'select',
        label: 'Digest frequency',
        required: true,
        choices: [
          { value: 'daily', label: 'Daily' },
          { value: 'weekly', label: 'Weekly' },
        ],
      },
    ],
    settings: {
      schema: [
        {
          key: 'showHints',
          type: 'boolean',
          label: 'Show hints',
          required: true,
          default: true,
        },
      ],
    },
  });

  assert.equal(parsed.preferences.length, 1);
  assert.equal(parsed.preferences[0].key, 'defaultNotebook');
  assert.equal(parsed.launchPreferences[0].choices?.[1].value, 'weekly');
  assert.equal(parsed.settings?.schema[0].default, true);
});
