import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  catalogUpdateState,
  catalogRepoReferenceToUrl,
  classifyAppUpdateRouting,
  isChannelSwitchConfirmationRequired,
  projectUpdateAvailability,
  recordedCatalogSourceIds,
  repositoriesMatch,
} from '../src/lib/market/update-routing';

const root = process.env.CONTROL_PANEL_ROOT || join(import.meta.dirname, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

const officialCatalog = {
  sourceId: 'official',
  sourceRepoUrl: 'https://forgejo.example.test/potemsla/YE-AppMarket',
  sourceRepoUrls: [
    'https://forgejo.example.test/potemsla/YE-AppMarket',
    'https://forgejo.example.test/example/Community-Market',
  ],
  entry: {
    path: 'apps/searxng',
    integration: 'basic' as const,
  },
  manifestIntegration: 'basic' as const,
};

test('relative catalog repositories require the configured Market origin', () => {
  assert.equal(catalogRepoReferenceToUrl('owner/App', undefined), undefined);
  assert.equal(
    catalogRepoReferenceToUrl('owner/App', 'https://forgejo.example.test/markets/Official'),
    'https://forgejo.example.test/owner/App',
  );
});

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
      manifestRepo: 'potemsla/YE-AppMarket',
      integration: 'basic',
    },
    catalog: officialCatalog,
    hasExplicitChannelOverride: false,
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
      sourceRepoUrl: 'https://forgejo.example.test/potemsla/YE-AppMarket.git',
      channelSource: 'https://forgejo.example.test/potemsla/YE-AppMarket/',
      installedBranch: 'main',
    },
    installMetadata: {
      sourceId: 'official',
      sourceRepoUrl: 'https://forgejo.example.test/potemsla/YE-AppMarket',
      manifestPath: 'apps/searxng/youeye-app.yaml',
      integration: 'basic',
    },
    catalog: officialCatalog,
    hasExplicitChannelOverride: false,
  });

  assert.equal(decision.kind, 'catalog');
  assert.equal(repositoriesMatch(
    'https://forgejo.example.test/potemsla/YE-AppMarket.git',
    'https://forgejo.example.test/potemsla/YE-AppMarket/',
  ), true);
});

test('a sourceRepoUrl outside every configured Market source remains explicit release provenance', () => {
  const decision = classifyAppUpdateRouting({
    appId: 'standalone',
    installed: {
      sourceId: 'official',
      sourceRepoUrl: 'https://forgejo.example.test/potemsla/YE-App-Standalone',
      installedBranch: 'main',
    },
    installMetadata: { sourceId: 'official', integration: 'basic' },
    catalog: officialCatalog,
    hasExplicitChannelOverride: false,
  });

  assert.equal(decision.kind, 'channel');
  assert.equal(decision.reason, 'legacy-release-source');
  assert.equal(decision.channelDefaultSource, 'https://forgejo.example.test/potemsla/YE-App-Standalone');
});

test('installedBranch alone never selects native release resolution', () => {
  const decision = classifyAppUpdateRouting({
    appId: 'legacy-external',
    installed: { installedBranch: 'main' },
    installMetadata: {},
    catalog: null,
    hasExplicitChannelOverride: false,
  });
  assert.equal(decision.kind, 'catalog');
});

test('native repo entries use the app repository, not the Market repository', () => {
  const decision = classifyAppUpdateRouting({
    appId: 'search',
    installed: {
      type: 'native',
      sourceId: 'official',
      sourceRepoUrl: 'https://forgejo.example.test/potemsla/YE-AppMarket',
      installedBranch: 'main',
    },
    installMetadata: { sourceId: 'official', integration: 'native' },
    catalog: {
      sourceId: 'official',
      sourceRepoUrl: 'https://forgejo.example.test/potemsla/YE-AppMarket',
      entry: { repo: 'potemsla/YE-App-Search', integration: 'native' },
      manifestIntegration: 'native',
    },
    hasExplicitChannelOverride: false,
  });

  assert.equal(decision.kind, 'channel');
  assert.equal(decision.reason, 'native-repo-catalog-entry');
  assert.equal(decision.channelDefaultSource, 'https://forgejo.example.test/potemsla/YE-App-Search');
});

test('explicit per-app override remains authoritative for an owner-managed channel', () => {
  const decision = classifyAppUpdateRouting({
    appId: 'searxng',
    installed: { sourceId: 'official' },
    installMetadata: { sourceId: 'official', integration: 'basic' },
    catalog: officialCatalog,
    hasExplicitChannelOverride: true,
  });
  assert.equal(decision.kind, 'channel');
  assert.equal(decision.reason, 'explicit-channel-override');
});

test('external availability never exposes native branch or switch state', () => {
  const routing = classifyAppUpdateRouting({
    appId: 'searxng',
    installed: { sourceId: 'official', installedBranch: 'main' },
    installMetadata: { sourceId: 'official', integration: 'basic' },
    catalog: officialCatalog,
    hasExplicitChannelOverride: false,
  });
  const result = projectUpdateAvailability({
    routing,
    installedVersion: '2026.7.26',
    installedBranch: 'main',
    catalogVersion: '2026.7.28',
    candidate: { version: '0.1.0', branch: 'dev', tag: 'v0.1.0' },
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

test('not-newer native branch changes remain switch-pending and confirm-gated', () => {
  const routing = {
    kind: 'channel' as const,
    reason: 'native-repo-catalog-entry' as const,
    channelDefaultSource: 'https://forgejo.example.test/potemsla/YE-App-Search',
  };
  const result = projectUpdateAvailability({
    routing,
    installedVersion: '1.2.0',
    installedBranch: 'main',
    catalogVersion: null,
    candidate: { version: '1.1.0', branch: 'dev', tag: 'dev-v1.1.0' },
  });

  assert.equal(result.updateAvailable, false);
  assert.equal(result.switchPending, true);
  assert.equal(isChannelSwitchConfirmationRequired({
    force: false,
    confirmSwitch: false,
    installedBranch: 'main',
    candidateBranch: 'dev',
    candidateIsNewer: false,
  }), true);
  assert.equal(isChannelSwitchConfirmationRequired({
    force: false,
    confirmSwitch: true,
    installedBranch: 'main',
    candidateBranch: 'dev',
    candidateIsNewer: false,
  }), false);
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
    hasExplicitChannelOverride: false,
  }).kind, 'catalog');
});

test('all supported update routes converge on the shared Market updater', () => {
  const settings = read('src/app/settings/api/apps/[appId]/update/route.ts');
  const appRoute = read('src/app/api/apps/[name]/update/route.ts');
  const compatibility = read('src/app/api/market/update/route.ts');
  const uiBridgeUpdate = read('src/app/api/ui-bridge/updates/[component]/route.ts');
  const marketUpdates = read('src/app/api/market/updates/route.ts');
  const uiBridgeApps = read('src/app/api/ui-bridge/apps/route.ts');

  assert.match(settings, /updateMarketApp\(\{ appId, force: true \}/);
  assert.match(appRoute, /updateMarketApp\(/);
  assert.match(compatibility, /POST as updateApp/);
  assert.match(uiBridgeUpdate, /updateMarketApp\(/);
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
  const installedApps = read('src/lib/market/installed-apps.ts');

  assert.match(updater, /const originalInstallMeta = structuredClone\(installMeta\)/);
  assert.match(updater, /saveInstallMetadata\(originalInstallMeta\)/);
  assert.match(updater, /restoreInstalledAppUpdateState\(appId, originalInstalledAppState\)/);
  assert.match(installedApps, /export async function restoreInstalledAppUpdateState/);
  assert.match(installedApps, /Object\.assign\(app, previous\)/);
});
