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
  assert.match(schema, /kind: z\.enum\(\['widget', 'info-card', 'timeline-card', 'notification'\]\)/);
  assert.match(schema, /placement: z\.enum\(\['dashboard', 'timeline', 'notification-center', 'app-settings', 'app-detail'\]\)/);
  assert.match(schema, /surfaces: z\.array\(SurfaceSchema\)\.optional\(\)\.default\(\[\]\)/);

  assert.match(types, /export type SurfaceSpec/);
  assert.match(types, /surfaces\?: SurfaceSpec\[\]/);
  assert.match(catalog, /surfaces: manifest\.surfaces/);
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
