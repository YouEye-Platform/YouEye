import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { openMarketSession } from '../src/lib/market/market-fetch';
import { sha256Hex } from '../src/lib/market/market-format';
import * as realSource from '../src/lib/market/source';
import { buildFixtureMarket } from './fixtures/market';
import { marketWorld, withMarketState } from './fixtures/market-world';

// The core containers (Caddy, PostgreSQL, Pi-hole) run images pinned in the Control Panel
// (src/lib/infrastructure/system-images.ts). No Market source can supply or replace them.

const testDir = dirname(fileURLToPath(import.meta.url));
const controlRoot = process.env.CONTROL_PANEL_ROOT || join(testDir, '..');
const repoRoot = join(controlRoot, '..', '..');
const nodeRequire = createRequire(import.meta.url);

const PINS = {
  caddy: { version: '2.11.4', image: 'docker.io/library/caddy@sha256:0c994536bddb66445885237f1a5dcc1916bccea922661c76b4e9fc24061f9b52', containerName: 'youeye-caddy' },
  pihole: { version: '2026.05.0', image: 'docker.io/pihole/pihole@sha256:70a9c11171ded2eee735d88c127996da209284a329d50f5ae59c06b861d401b3', containerName: 'youeye-pihole' },
  postgresql: { version: '17.10', image: 'docker.io/library/postgres@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193', containerName: 'youeye-postgres' },
};

function readControl(path: string): string {
  return readFileSync(join(controlRoot, path), 'utf8');
}

/** Run a source file with its imports replaced (real Node built-ins pass through). */
function load(path: string, dependencies: Record<string, unknown>): Record<string, any> {
  const output = ts.transpileModule(readControl(path), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: path,
  }).outputText;
  const exports = {};
  new Function('require', 'exports', output)((name: string) => {
    if (name in dependencies) return dependencies[name];
    if (/^(node:)?(fs|fs\/promises|path|crypto)$/.test(name)) return nodeRequire(name);
    throw new Error(`Unexpected dependency of ${path}: ${name}`);
  }, exports);
  return exports;
}

type IncusCall = { method: string; path: string; body?: any };

function infrastructure(configs: Partial<Record<string, Record<string, string> | null>>) {
  const calls: IncusCall[] = [];
  const incus = {
    incusRequest: async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body });
      const name = path.split('/')[3];
      if (path.endsWith('/state')) return { metadata: { status: 'Running' } };
      if (method === 'GET') {
        const config = configs[name];
        return config === null || config === undefined ? { error: 'not found' } : { metadata: { config } };
      }
      return {};
    },
    execCommand: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
  };
  const images = load('src/lib/infrastructure/system-images.ts', { '@/lib/incus/server': incus });
  const updater = load('src/lib/infrastructure/system-updater.ts', {
    '@/lib/incus/server': incus,
    '@/lib/incus/snapshot': {},
    './resource-policy': {},
    './secrets': {},
    './health-checks': {},
    './system-images': images,
  });
  return { calls, images, updater };
}

const recorded = (image: string, version: string) => ({ 'user.youeye.market.image': image, 'user.youeye.market.version': version });

test('the three core images are pinned by digest in the Control Panel', () => {
  const { images } = infrastructure({});
  assert.deepEqual(images.SYSTEM_IMAGES, PINS);
  assert.deepEqual([...images.SYSTEM_IMAGE_IDS].sort(), ['caddy', 'pihole', 'postgresql']);
  for (const pin of Object.values(images.SYSTEM_IMAGES) as Array<{ image: string }>) {
    assert.match(pin.image, /^docker\.io\/[a-z0-9/._-]+@sha256:[0-9a-f]{64}$/);
  }
});

test('the core container manifests use the pins and no moving tag', () => {
  const { images } = infrastructure({});
  const manifests = load('src/lib/infrastructure/manifests.ts', { './system-images': images });
  assert.equal(manifests.caddyManifest('10.0.0.2').image, PINS.caddy.image);
  assert.equal(manifests.piholeManifest('192.0.2.10').image, PINS.pihole.image);
  assert.equal(manifests.postgresManifest('secret').image, PINS.postgresql.image);
  assert.equal(manifests.caddyManifest('10.0.0.2').containerName, 'youeye-caddy');
  assert.equal(manifests.piholeManifest('192.0.2.10').containerName, 'youeye-pihole');
  assert.equal(manifests.postgresManifest('secret').containerName, 'youeye-postgres');
  assert.doesNotMatch(readControl('src/lib/infrastructure/manifests.ts'), /docker\.io|:latest|17-alpine/);
});

test('system plans compare each container with its pin', async () => {
  const { updater } = infrastructure({
    'youeye-caddy': recorded(PINS.caddy.image, PINS.caddy.version),
    'youeye-pihole': recorded('docker.io/pihole/pihole:latest', '2025.01.0'),
    'youeye-postgres': {},
  });
  const plans = Object.fromEntries((await updater.planSystemUpdates()).map((plan: any) => [plan.id, plan]));
  assert.deepEqual(Object.keys(plans).sort(), ['caddy', 'pihole', 'postgresql']);
  for (const [id, pin] of Object.entries(PINS)) {
    assert.equal(plans[id].desiredImage, pin.image);
    assert.equal(plans[id].desiredVersion, pin.version);
    assert.equal(plans[id].containerName, pin.containerName);
    for (const gone of ['sourceId', 'manifestPath', 'manifestDigest']) assert.equal(gone in plans[id], false);
  }
  assert.equal(plans.caddy.trackingStatus, 'tracked');
  assert.equal(plans.caddy.updateAvailable, false);
  assert.equal(plans.pihole.trackingStatus, 'tracked');
  assert.equal(plans.pihole.updateAvailable, true);
  assert.equal(plans.pihole.currentVersion, '2025.01.0');
  assert.equal(plans.postgresql.trackingStatus, 'untracked');

  const { updater: missing } = infrastructure({});
  assert.ok((await missing.planSystemUpdates()).every((plan: any) => plan.trackingStatus === 'missing' && !plan.exists));
});

test('a deployed container records only its pinned image and version', async () => {
  const { calls, images } = infrastructure({});
  await images.recordSystemContainerImage('pihole');
  assert.deepEqual(calls, [{
    method: 'PATCH', path: '/1.0/instances/youeye-pihole',
    body: { config: recorded(PINS.pihole.image, PINS.pihole.version) },
  }]);
});

test('the deployer and the updater take the images from the pins, never from the Market', () => {
  const deployer = readControl('src/lib/infrastructure/deployer.ts');
  for (const id of ['postgresql', 'caddy', 'pihole']) {
    assert.match(deployer, new RegExp(`recordSystemContainerImage\\('${id}'\\)`));
  }
  for (const file of ['system-images.ts', 'system-updater.ts', 'manifests.ts']) {
    assert.doesNotMatch(readControl(`src/lib/infrastructure/${file}`), /from ['"](@\/lib\/market|\.\.\/market)\//, file);
  }
  assert.doesNotMatch(deployer, /from ['"](@\/lib\/market|\.\.\/market)\/(catalog|source)['"]/);
  assert.equal(existsSync(join(controlRoot, 'src/lib/infrastructure/system-market-manifests.ts')), false);
  assert.equal(existsSync(join(controlRoot, 'src/app/api/deploy/infrastructure/system-manifests')), false);
});

test('the Market lists apps only: no system items in its code or its API', () => {
  const catalog = readControl('src/lib/market/catalog.ts');
  assert.doesNotMatch(catalog, /fetchAvailableSystemApps|fetchSystemManifest|systemManifestToMarketApp|parseSystemApp/);
  assert.doesNotMatch(readControl('src/lib/market/app-format/schema.ts'), /SystemAppSchema|youeye\.system-app\.v1/);
  assert.doesNotMatch(readControl('src/lib/market/app-format/parse.ts'), /parseSystemApp/);
  assert.doesNotMatch(readControl('src/app/api/market/route.ts'), /systemApps/);
  assert.doesNotMatch(readControl('src/app/api/market/catalog/route.ts'), /systemApps/);
});

test('a market that lists system items and carries a system/caddy.yaml changes nothing', withMarketState(async (directory) => {
  const address = 'https://markets.example.org/someone/';
  // A market in the published format, plus what an older catalog repository had: a `system` list and system files.
  const built = buildFixtureMarket({ sequence: 1795000000, apps: [{ id: 'demo' }] });
  const index = Buffer.from(JSON.stringify({ ...JSON.parse(built.files.get(built.indexPath)!.toString('utf8')), system: ['caddy'] }));
  const indexSha = sha256Hex(index);
  const files = new Map(built.files);
  files.delete(built.indexPath);
  files.set(`h/index/${indexSha}.json`, index);
  files.set('market.json', Buffer.from(JSON.stringify({ ...JSON.parse(built.pointer.toString('utf8')), index: { path: `h/index/${indexSha}.json`, sha256: indexSha, size: index.length } })));
  files.set('system/caddy.yaml', Buffer.from([
    'schema: youeye.system-app.v1', 'id: caddy', 'version: 9.9.9', 'name: Caddy',
    'image: docker.io/someone/caddy@sha256:' + 'f'.repeat(64), '',
  ].join('\n')));
  writeFileSync(join(directory, 'market-sources.json'), JSON.stringify({ active_sources: [
    { id: 'official', enabled: false },
    { id: 'someone', name: 'Someone', url: address, enabled: true, priority: 1, accepted_at: '2026-11-18T10:00:00.000Z' },
  ] }));
  const world = marketWorld({ [address]: files });
  const custom = (await realSource.getConfiguredMarketSources()).find((source) => source.id === 'someone')!;

  const catalog = await world.catalog.fetchCatalog(custom);
  assert.deepEqual(catalog.apps, [{ id: 'demo', integration: 'basic', path: 'apps/demo' }]);
  assert.equal('system' in catalog, false);
  assert.deepEqual((await world.catalog.fetchAvailableApps()).map((app: any) => app.id), ['demo']);
  const fetched = world.hosts.requests.map((request) => request.path);
  assert.ok(fetched.every((file) => file === 'market.json' || file.startsWith('h/')), `fetched: ${fetched.join(', ')}`);
  assert.equal('fetchAvailableSystemApps' in world.catalog, false);
  // Only the paths of the format can be asked for at all.
  const session = await openMarketSession(address, world.hosts.deps);
  await assert.rejects(session.get('system/caddy.yaml', 'bundle'), /Not a market file path/);

  // The plan for the core containers is the same as without any source.
  const { updater } = infrastructure({ 'youeye-caddy': recorded(PINS.caddy.image, PINS.caddy.version) });
  const caddy = (await updater.planSystemUpdates()).find((plan: any) => plan.id === 'caddy');
  assert.equal(caddy.desiredImage, PINS.caddy.image);
  assert.equal(caddy.updateAvailable, false);
}));

// The app-market is a SEPARATE repo (YE-AppMarket). Resolve it across names + env override.
function resolveMarketRoot(): string | null {
  const candidates = [process.env.MARKET_ROOT, join(repoRoot, 'YE-AppMarket'), join(repoRoot, 'Market')]
    .filter((p): p is string => Boolean(p));
  return candidates.find((p) => existsSync(join(p, 'catalog.yaml'))) ?? null;
}

test('the Market catalog validates with the Control Panel parser', (t) => {
  const marketRoot = resolveMarketRoot();
  if (!marketRoot) {
    t.skip('YE-AppMarket repo not checked out beside YouEye (set MARKET_ROOT)');
    return;
  }
  const result = spawnSync(process.execPath, ['--import', 'tsx', join(controlRoot, 'scripts', 'validate-app-sources.ts'), marketRoot],
    { cwd: controlRoot, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /all valid/);
  assert.doesNotMatch(result.stdout, /\/system\//);
});
