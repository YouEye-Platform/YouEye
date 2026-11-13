import { spawnSync } from 'node:child_process';
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

test('system app manifests are first-class Market artifacts', () => {
  const schema = readControl('src/lib/market/app-format/schema.ts');
  const parser = readControl('src/lib/market/app-format/parse.ts');
  const catalog = readControl('src/lib/market/catalog.ts');
  const api = readControl('src/app/api/market/catalog/route.ts');
  const systemManifestApi = readControl('src/app/api/deploy/infrastructure/system-manifests/route.ts');
  const systemUpdatesApi = readControl('src/app/api/deploy/infrastructure/system-updates/route.ts');
  const source = readControl('src/lib/market/source.ts');
  const engine = readControl('src/lib/market/engine.ts');
  const resolver = readControl('src/lib/infrastructure/system-market-manifests.ts');
  const updater = readControl('src/lib/infrastructure/system-updater.ts');
  const deployer = readControl('src/lib/infrastructure/deployer.ts');

  assert.match(schema, /SystemAppSchema/);
  assert.match(schema, /schema: z\.literal\('youeye\.system-app\.v1'\)/);
  assert.match(parser, /export function parseSystemApp/);
  assert.match(catalog, /fetchAvailableSystemApps/);
  assert.match(catalog, /systemManifestToMarketApp/);
  assert.match(api, /systemApps/);
  assert.match(systemManifestApi, /resolveSystemImageOverrides/);
  assert.match(systemManifestApi, /requireAdmin/);
  assert.match(systemUpdatesApi, /planSystemUpdates/);
  assert.match(systemUpdatesApi, /updateSystemFromMarket/);
  assert.match(systemUpdatesApi, /adoptUntracked/);
  assert.match(systemUpdatesApi, /allowDatabaseUpdate/);
  // The official Market is the channel index's catalog release; no repository is built in.
  assert.match(source, /kind: 'channel'/);
  assert.doesNotMatch(source, /YouEye-Platform\/Market|git\.potemk\.in/);
  assert.doesNotMatch(engine, /private forge/i);
  assert.match(resolver, /resolveSystemImageOverrides/);
  assert.match(resolver, /Required Market system manifest/);
  assert.match(resolver, /recordSystemContainerManifest/);
  assert.match(resolver, /user\.youeye\.market\.image/);
  assert.match(updater, /'untracked'/);
  assert.match(updater, /PostgreSQL system updates require allowDatabaseUpdate/);
  assert.match(updater, /adoptUntracked/);
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

test('the Market catalog and its system apps validate with the Control Panel parser', (t) => {
  const marketRoot = resolveMarketRoot();
  if (!marketRoot) {
    t.skip('YE-AppMarket repo not checked out beside YouEye (set MARKET_ROOT)');
    return;
  }
  const result = spawnSync(process.execPath, ['--import', 'tsx', join(controlRoot, 'scripts', 'validate-app-sources.ts'), marketRoot],
    { cwd: controlRoot, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  for (const id of ['postgresql', 'pihole', 'caddy']) assert.match(result.stdout, new RegExp(`ok    \\S+/system/${id}\\.yaml`));
});
