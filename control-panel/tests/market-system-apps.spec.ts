import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const controlRoot = process.env.CONTROL_PANEL_ROOT || join(import.meta.dirname, '..');
const marketRoot = process.env.MARKET_ROOT || join(controlRoot, '..', '..', 'YE-AppMarket');

function readControl(path: string): string {
  return readFileSync(join(controlRoot, path), 'utf8');
}

function readMarket(path: string): string {
  return readFileSync(join(marketRoot, path), 'utf8');
}

test('system app manifests are first-class Market artifacts', () => {
  const schema = readControl('src/lib/market/schema.ts');
  const parser = readControl('src/lib/market/parser.ts');
  const catalog = readControl('src/lib/market/catalog.ts');
  const api = readControl('src/app/api/market/catalog/route.ts');

  assert.match(schema, /SystemAppManifestSchema/);
  assert.match(schema, /kind:\s*z\.literal\('system-app'\)/);
  assert.match(parser, /parseSystemManifest/);
  assert.match(catalog, /fetchAvailableSystemApps/);
  assert.match(catalog, /systemManifestToMarketApp/);
  assert.match(api, /systemApps/);
});

test('Market system catalog entries resolve to pinned system manifests', () => {
  const catalog = readMarket('catalog.yaml');

  const expected = new Map([
    ['postgresql', { version: '17.10', file: 'system/postgresql.yaml', image: 'docker.io/library/postgres:17.10-alpine', containerName: 'youeye-postgres' }],
    ['pihole', { version: '2026.05.0', file: 'system/pihole.yaml', image: 'docker.io/pihole/pihole:2026.05.0', containerName: 'youeye-pihole' }],
    ['caddy', { version: '2.11.4', file: 'system/caddy.yaml', image: 'docker.io/library/caddy:2.11.4', containerName: 'youeye-caddy' }],
  ]);

  for (const [id, target] of expected) {
    assert.match(catalog, new RegExp(`id: ${id}[\\s\\S]*file: ${target.file}[\\s\\S]*latestVersion: "${target.version}"`));
    const manifest = readMarket(target.file);
    assert.match(manifest, /kind: system-app/);
    assert.match(manifest, new RegExp(`id: "${id}"`));
    assert.match(manifest, new RegExp(`version: "${target.version}"`));
    assert.match(manifest, new RegExp(`image: "${target.image.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
    assert.match(manifest, new RegExp(`containerName: "${target.containerName}"`));
  }
});
