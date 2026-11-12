import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  catalogUpdateState,
  classifyAppUpdateRouting,
  projectUpdateAvailability,
  recordedCatalogSourceIds,
  repositoriesMatch,
} from '../src/lib/market/update-routing';

const root = process.env.CONTROL_PANEL_ROOT || join(import.meta.dirname, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

const officialCatalog = {
  sourceId: 'official',
  sourceRepoUrl: '',
  sourceRepoUrls: ['https://forgejo.example.test/example/Community-Market'],
  entry: {
    path: 'apps/searxng',
    integration: 'basic' as const,
  },
  manifestIntegration: 'basic' as const,
};

test('recorded source identities prefer install metadata and fall back across legacy state', () => {
  assert.deepEqual(recordedCatalogSourceIds(
    { sourceId: 'legacy', catalogKey: 'third:app:searxng' },
    { sourceId: 'official', catalogKey: 'official:app:searxng' },
  ), ['official', 'legacy', 'third']);
});

test('legacy SearXNG state stays on its recorded external Market source', () => {
  const decision = classifyAppUpdateRouting({
    appId: 'searxng',
    installed: {
      type: 'basic',
      sourceId: 'official',
      catalogKey: 'official:app:searxng',
      installedBranch: 'main',
      sourceRepoUrl: null,
      channelSource: null,
    },
    installMetadata: {
      sourceId: 'official',
      catalogKey: 'official:app:searxng',
      manifestPath: 'apps/searxng/youeye-app.yaml',
      manifestRepo: 'official',
      integration: 'basic',
    },
    catalog: officialCatalog,
  });

  assert.deepEqual(decision, {
    kind: 'catalog',
    reason: 'recorded-external-catalog',
    catalogSourceId: 'official',
  });
});

test('Market repository provenance is not mistaken for an app release repository', () => {
  const decision = classifyAppUpdateRouting({
    appId: 'searxng',
    installed: {
      sourceId: 'official',
      sourceRepoUrl: 'https://forgejo.example.test/owner/YE-AppMarket.git',
      channelSource: 'https://forgejo.example.test/owner/YE-AppMarket/',
      installedBranch: 'main',
    },
    installMetadata: {
      sourceId: 'official',
      sourceRepoUrl: 'https://forgejo.example.test/owner/YE-AppMarket',
      manifestPath: 'apps/searxng/youeye-app.yaml',
      integration: 'basic',
    },
    catalog: officialCatalog,
  });

  assert.equal(decision.kind, 'catalog');
  assert.equal(repositoriesMatch(
    'https://forgejo.example.test/owner/YE-AppMarket.git',
    'https://forgejo.example.test/owner/YE-AppMarket/',
  ), true);
});

test('a recorded release repository never turns a catalog app into a channel app', () => {
  const decision = classifyAppUpdateRouting({
    appId: 'standalone',
    installed: {
      sourceId: 'official',
      sourceRepoUrl: 'https://forgejo.example.test/team/Standalone',
      channelSource: 'https://forgejo.example.test/team/Standalone',
    },
    installMetadata: { sourceId: 'official', integration: 'basic' },
    catalog: officialCatalog,
  });
  assert.equal(decision.kind, 'catalog');
});

test('installedBranch alone never selects native release resolution', () => {
  const decision = classifyAppUpdateRouting({
    appId: 'legacy-external',
    installed: { installedBranch: 'main' },
    installMetadata: {},
    catalog: null,
  });
  assert.equal(decision.kind, 'catalog');
});

test('native apps resolve through the channel index by id', () => {
  const decision = classifyAppUpdateRouting({
    appId: 'search',
    installed: { type: 'native', sourceId: 'official' },
    installMetadata: { sourceId: 'official', integration: 'native' },
    catalog: {
      sourceId: 'official',
      sourceRepoUrl: '',
      entry: { integration: 'native' },
      manifestIntegration: 'native',
    },
  });
  assert.deepEqual(decision, { kind: 'channel', reason: 'native-app', catalogSourceId: 'official' });
});

test('external availability never exposes native branch or switch state', () => {
  const routing = classifyAppUpdateRouting({
    appId: 'searxng',
    installed: { sourceId: 'official', installedBranch: 'main' },
    installMetadata: { sourceId: 'official', integration: 'basic' },
    catalog: officialCatalog,
  });
  const result = projectUpdateAvailability({
    routing,
    installedVersion: '2026.7.26',
    catalogVersion: '2026.7.28',
    candidate: { version: '0.1.0', tag: 'v0.1.0' },
  });

  assert.deepEqual(result, {
    catalogVersion: '2026.7.28',
    updateAvailable: true,
    switchPending: false,
    candidateVersion: '2026.7.28',
    candidateBranch: null,
    candidateTag: null,
  });
});

test('a native channel head older than the installed version is never offered', () => {
  const routing = { kind: 'channel' as const, reason: 'native-app' as const };
  const behind = projectUpdateAvailability({
    routing,
    installedVersion: '0.6.2-rc.1',
    catalogVersion: null,
    candidate: { version: '0.6.1-rc.4', tag: 'v0.6.1-rc.4' },
  });
  assert.equal(behind.updateAvailable, false);
  assert.equal(behind.switchPending, false);
  const ahead = projectUpdateAvailability({
    routing,
    installedVersion: '0.6.1-rc.4',
    catalogVersion: null,
    candidate: { version: '0.6.2-rc.1', tag: 'v0.6.2-rc.1' },
  });
  assert.equal(ahead.updateAvailable, true);
  assert.equal(ahead.candidateTag, 'v0.6.2-rc.1');
});

test('successful catalog updates clear synthetic native provenance for the next update', () => {
  const nextState = catalogUpdateState('2026.7.28');
  assert.deepEqual(nextState, {
    installedVersion: '2026.7.28',
    catalogVersion: '2026.7.28',
    installedTag: null,
    installedBranch: null,
    channelSource: null,
    candidateVersion: null,
    candidateBranch: null,
    candidateTag: null,
    updateAvailable: false,
    switchPending: false,
  });
  assert.equal(classifyAppUpdateRouting({
    appId: 'searxng',
    installed: { sourceId: 'official', ...nextState },
    installMetadata: { sourceId: 'official', integration: 'basic' },
    catalog: officialCatalog,
  }).kind, 'catalog');
});

test('all supported update routes converge on the shared Market updater', () => {
  const settings = read('src/app/settings/api/apps/[appId]/update/route.ts');
  const appRoute = read('src/app/api/apps/[name]/update/route.ts');
  const compatibility = read('src/app/api/market/update/route.ts');
  const uiBridgeUpdate = read('src/app/api/ui-bridge/updates/[component]/route.ts');
  const marketUpdates = read('src/app/api/market/updates/route.ts');
  const uiBridgeApps = read('src/app/api/ui-bridge/apps/route.ts');

  assert.match(settings, /handleMarketUpdate\(request, appId, 'json'\)/);
  assert.match(appRoute, /handleMarketUpdate\(req, name\)/);
  assert.match(compatibility, /handleMarketUpdate\(req\)/);
  assert.match(uiBridgeUpdate, /handleMarketUpdate\(request, component, 'json'\)/);
  assert.match(marketUpdates, /getAppsWithUpdatesAvailable/);
  assert.match(uiBridgeApps, /getAllInstalledApps/);
  assert.match(uiBridgeApps, /dbEntry\?\.catalogVersion/);
});

test('unified app availability consumes the shared recorded-source projection', () => {
  const unified = read('src/app/api/apps/unified/route.ts');
  assert.match(unified, /const marketUpdate = dbEntry\?\.updateAvailable === true/);
  assert.doesNotMatch(unified, /isNewer\(catV, insV\)/);
});

test('late update failure restores both durable metadata views', () => {
  const updater = read('src/lib/market/updater.ts');
  const provider = read('src/lib/market/update-provider.ts');
  const installedApps = read('src/lib/market/installed-apps.ts');

  assert.match(updater, /const originalInstallMeta = structuredClone\(installMeta\)/);
  assert.match(updater, /runAppUpdateTransaction/);
  assert.match(provider, /saveInstallMetadata\(restored\)/);
  assert.match(provider, /restoreInstalledAppUpdateState\(record\.appId, plan\.installed\)/);
  assert.match(installedApps, /export async function restoreInstalledAppUpdateState/);
  assert.match(provider, /const restored = \{ \.\.\.current \}/);
});
