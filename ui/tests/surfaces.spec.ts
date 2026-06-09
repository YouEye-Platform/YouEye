import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAppSurfaces } from '../src/lib/surfaces/normalize';

const uiRoot = process.env.UI_ROOT || join(import.meta.dirname, '..');

function read(path: string): string {
  return readFileSync(join(uiRoot, path), 'utf8');
}

test('UI normalizes widgets, info cards, timeline cards, notifications, and surfaces', () => {
  const normalizer = read('src/lib/surfaces/normalize.ts');
  const appManagement = read('src/lib/db/queries/app-management.ts');
  const widgetsRoute = read('src/app/api/v1/apps/widgets/route.ts');
  const surfacesRoute = read('src/app/api/v1/apps/surfaces/route.ts');

  assert.match(normalizer, /export function normalizeAppSurfaces/);
  assert.match(normalizer, /legacyWidgetToSurface/);
  assert.match(normalizer, /legacyInfoCardToSurface/);
  assert.match(normalizer, /legacyTimelineEmbedToSurface/);
  assert.match(normalizer, /capabilities\.notifications/);
  assert.match(normalizer, /kind: "notification"/);

  assert.match(appManagement, /getAppSurfaceDeclarations/);
  assert.match(appManagement, /normalizeAppSurfaces/);
  assert.match(appManagement, /liveManifest/);
  assert.match(appManagement, /app\.manifest/);
  assert.match(appManagement, /getInfoCardProviders/);
  assert.match(appManagement, /surface\.kind === "info-card"/);
  assert.match(appManagement, /endpoint: surface\.embedPath/);

  assert.match(widgetsRoute, /getAppSurfaceDeclarations/);
  assert.match(widgetsRoute, /surface\.kind === "widget"/);
  assert.match(widgetsRoute, /surface\.placement === "dashboard"/);
  assert.match(widgetsRoute, /embed_path: w\.embedPath/);

  assert.match(surfacesRoute, /surfaces: declarations\.flatMap/);
  assert.match(surfacesRoute, /legacy_source: surface\.legacySource/);
});

test('surface normalizer maps new and legacy declarations into one model', () => {
  const surfaces = normalizeAppSurfaces({
    surfaces: [{
      id: 'quick-search',
      kind: 'widget',
      placement: 'dashboard',
      name: 'Quick search',
      embedPath: '/embed/widget/quick-search',
      permissions: ['profile:read'],
      defaultSize: { width: 20, height: 12 },
    }],
    widgets: [{
      id: 'legacy-clock',
      name: 'Legacy clock',
      description: 'Old widget declaration',
      default_size: { width: 12, height: 8 },
    }],
    info_cards: [{
      type: 'movie',
      description: 'Movie info',
      endpoint: '/embed/info/movie',
      triggers: ['movie'],
    }],
    timeline_embeds: [{
      entry_type: 'memo-created',
      embed_path: '/embed/timeline/memo-created',
    }],
    capabilities: {
      notifications: true,
    },
  });

  assert.equal(surfaces.length, 5);
  assert.deepEqual(
    surfaces.map((surface) => `${surface.kind}:${surface.placement}:${surface.id}`).sort(),
    [
      'info-card:timeline:movie',
      'notification:notification-center:default-notification',
      'timeline-card:timeline:memo-created',
      'widget:dashboard:legacy-clock',
      'widget:dashboard:quick-search',
    ],
  );
  assert.equal(surfaces.find((surface) => surface.id === 'quick-search')?.permissions[0], 'profile:read');
  assert.equal(surfaces.find((surface) => surface.id === 'legacy-clock')?.embedPath, '/embed/widget/legacy-clock');
});
