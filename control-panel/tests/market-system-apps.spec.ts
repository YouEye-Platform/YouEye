import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const testDir = dirname(fileURLToPath(import.meta.url));
const controlRoot = process.env.CONTROL_PANEL_ROOT || join(testDir, '..');
const repoRoot = join(controlRoot, '..', '..');

// The app-market is a SEPARATE repo (YE-AppMarket; GitHub name "Market"). Resolve
// it robustly across both names + env override; null when it isn't checked out.
function resolveMarketRoot(): string | null {
  const candidates = [
    process.env.MARKET_ROOT,
    join(repoRoot, 'YE-AppMarket'),
    join(repoRoot, 'Market'),
  ].filter((p): p is string => Boolean(p));
  return candidates.find((p) => existsSync(join(p, 'catalog.yaml'))) ?? null;
}

function readControl(path: string): string {
  return readFileSync(join(controlRoot, path), 'utf8');
}

function readMarket(marketRoot: string, path: string): string {
  return readFileSync(join(marketRoot, path), 'utf8');
}

test('system app manifests are first-class Market artifacts', () => {
  const schema = readControl('src/lib/market/schema.ts');
  const parser = readControl('src/lib/market/parser.ts');
  const catalog = readControl('src/lib/market/catalog.ts');
  const api = readControl('src/app/api/market/catalog/route.ts');
  const systemManifestApi = readControl('src/app/api/deploy/infrastructure/system-manifests/route.ts');
  const systemUpdatesApi = readControl('src/app/api/deploy/infrastructure/system-updates/route.ts');
  const source = readControl('src/lib/market/source.ts');
  const engine = readControl('src/lib/market/engine.ts');
  const resolver = readControl('src/lib/infrastructure/system-market-manifests.ts');
  const updater = readControl('src/lib/infrastructure/system-updater.ts');
  const deployer = readControl('src/lib/infrastructure/deployer.ts');

  assert.match(schema, /SystemAppManifestSchema/);
  assert.match(schema, /kind:\s*z\.literal\('system-app'\)/);
  assert.match(parser, /parseSystemManifest/);
  assert.match(catalog, /fetchAvailableSystemApps/);
  assert.match(catalog, /systemManifestToMarketApp/);
  assert.match(api, /systemApps/);
  assert.match(systemManifestApi, /resolveSystemImageOverrides/);
  assert.match(systemManifestApi, /requireAdmin/);
  assert.match(systemUpdatesApi, /planSystemUpdates/);
  assert.match(systemUpdatesApi, /updateSystemFromMarket/);
  assert.match(systemUpdatesApi, /forceLegacy/);
  assert.match(systemUpdatesApi, /allowDatabaseUpdate/);
  assert.match(source, /DEFAULT_MARKET_REPO_URL = 'https:\/\/github\.com\/YouEye-Platform\/Market'/);
  assert.doesNotMatch(engine, /private forge/i);
  assert.match(engine, /getMarketSource/);
  assert.match(resolver, /resolveSystemImageOverrides/);
  assert.match(resolver, /Required Market system manifest/);
  assert.match(resolver, /recordSystemContainerManifest/);
  assert.match(resolver, /user\.youeye\.market\.image/);
  assert.match(updater, /legacy-compatible/);
  assert.match(updater, /legacy-untracked/);
  assert.match(updater, /PostgreSQL system updates require allowDatabaseUpdate/);
  assert.match(updater, /forceLegacy/);
  assert.match(updater, /rebuildContainer/);
  assert.match(updater, /recordSystemContainerManifest/);
  assert.match(deployer, /resolveSystemImageOverrides/);
  assert.match(deployer, /applySystemImage\(postgresManifest/);
  assert.match(deployer, /applySystemImage\(caddyManifest/);
  assert.match(deployer, /applySystemImage\(piholeManifest/);
  assert.match(deployer, /recordSystemContainerManifest\('postgresql'/);
  assert.match(deployer, /recordSystemContainerManifest\('caddy'/);
  assert.match(deployer, /recordSystemContainerManifest\('pihole'/);
});

test('Market system catalog entries resolve to pinned system manifests', (t) => {
  const marketRoot = resolveMarketRoot();
  if (!marketRoot) {
    t.skip('YE-AppMarket repo not checked out beside YouEye (set MARKET_ROOT) — catalog assertion needs the separate market repo');
    return;
  }
  const catalog = readMarket(marketRoot, 'catalog.yaml');

  const expected = new Map([
    ['postgresql', { version: '17.10', file: 'system/postgresql.yaml', image: 'docker.io/library/postgres:17.10-alpine', containerName: 'youeye-postgres' }],
    ['pihole', { version: '2026.05.0', file: 'system/pihole.yaml', image: 'docker.io/pihole/pihole:2026.05.0', containerName: 'youeye-pihole' }],
    ['caddy', { version: '2.11.4', file: 'system/caddy.yaml', image: 'docker.io/library/caddy:2.11.4', containerName: 'youeye-caddy' }],
  ]);

  for (const [id, target] of expected) {
    assert.match(catalog, new RegExp(`id: ${id}[\\s\\S]*file: ${target.file}[\\s\\S]*latestVersion: "${target.version}"`));
    const manifest = readMarket(marketRoot, target.file);
    assert.match(manifest, /kind: system-app/);
    assert.match(manifest, new RegExp(`id: "${id}"`));
    assert.match(manifest, new RegExp(`version: "${target.version}"`));
    assert.match(manifest, new RegExp(`image: "${target.image.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
    assert.match(manifest, new RegExp(`containerName: "${target.containerName}"`));
  }
});
