import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  catalogUpdateState,
  classifyAppUpdateRouting,
  compareToInstalledNative,
  projectUpdateAvailability,
  recordedCatalogSourceIds,
  recordedSourceAddressChange,
  sameMarketAddress,
} from '../src/lib/market/update-routing';

const root = process.env.CONTROL_PANEL_ROOT || join(import.meta.dirname, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

const officialCatalog = {
  sourceId: 'official',
  entry: {
    path: 'apps/searxng',
    integration: 'basic' as const,
  },
  manifestIntegration: 'basic' as const,
};

test('recorded source identities prefer install metadata and fall back across installed-apps state', () => {
  assert.deepEqual(recordedCatalogSourceIds(
    { sourceId: 'recorded', catalogKey: 'third:app:searxng' },
    { sourceId: 'official', catalogKey: 'official:app:searxng' },
  ), ['official', 'recorded', 'third']);
});

test('SearXNG with an installed branch stays on its recorded external Market source', () => {
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
});

test('an app follows the market address it recorded: one written form, and a repository URL matches no market', () => {
  const friend = { kind: 'url', name: 'Friend', url: 'https://markets.example.org/friend/' };
  assert.equal(sameMarketAddress('https://markets.example.org/friend', 'https://MARKETS.example.org/friend/'), true);
  assert.equal(sameMarketAddress('https://markets.example.org/friend/market.json', 'https://markets.example.org/friend/'), true);
  assert.equal(sameMarketAddress('https://markets.example.org/friend/', 'https://markets.example.org/friend/dev/'), false);
  assert.equal(sameMarketAddress('', ''), false);
  assert.equal(sameMarketAddress(undefined, 'https://markets.example.org/friend/'), false);
  assert.equal(sameMarketAddress('http://markets.example.org/friend/', 'https://markets.example.org/friend/'), false, 'not a market address');

  assert.equal(recordedSourceAddressChange({ sourceRepoUrl: 'https://markets.example.org/friend' }, friend), null);
  assert.equal(recordedSourceAddressChange({ sourceRepoUrl: undefined }, friend), null, 'nothing recorded: nothing to compare');
  const moved = recordedSourceAddressChange({ sourceRepoUrl: 'https://markets.example.org/other/' }, friend)!;
  assert.equal(moved.recordedAddress, 'https://markets.example.org/other/');
  assert.match(moved.message, /installed from https:\/\/markets\.example\.org\/other\/; the Market source "Friend" now points at https:\/\/markets\.example\.org\/friend\//);
  // A git repository recorded before markets were read by address is another address than any market.
  assert.match(recordedSourceAddressChange({ sourceRepoUrl: 'https://git.example.test/friend/market' }, friend)!.message, /installed from https:\/\/git\.example\.test\/friend\/market;/);
  // The official Market's address follows the box's channel and is never "changed".
  assert.equal(recordedSourceAddressChange({ sourceRepoUrl: 'https://market.youeye.me/dev/' }, { kind: 'official', name: 'Official YouEye Market', url: '' }), null);
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
    appId: 'external-app',
    installed: { installedBranch: 'main' },
    installMetadata: {},
    catalog: null,
  });
  assert.equal(decision.kind, 'catalog');
});

test('native apps update from their market like container apps (YE-142)', () => {
  const decision = classifyAppUpdateRouting({
    appId: 'search',
    installed: { type: 'native', sourceId: 'official' },
    installMetadata: { sourceId: 'official', integration: 'native' },
    catalog: { sourceId: 'official', entry: { path: 'apps/search', integration: 'native' }, manifestIntegration: 'native' },
  });
  assert.deepEqual(decision, { kind: 'catalog', reason: 'recorded-external-catalog', catalogSourceId: 'official' });
  // A native app installed before 0.6.20 from the channel (no market entry resolved yet) has the same route.
  assert.equal(classifyAppUpdateRouting({ appId: 'notes', installed: { type: 'native', installedTag: 'v0.6.4' } as never,
    installMetadata: { integration: 'native', manifestPath: 'youeye-app.yaml', manifestRepo: 'https://github.com/YouEye-Platform/Notes' } }).kind, 'catalog');
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

test('a market update is a newer version; the same package under another name is none (YE-142)', () => {
  const routing = { kind: 'catalog' as const, reason: 'recorded-external-catalog' as const };
  const installed = 'a'.repeat(64), other = 'b'.repeat(64);
  const project = (installedVersion: string, catalogVersion: string, installedArtifactSHA256?: string[], candidateArtifactSHA256?: string) =>
    projectUpdateAvailability({ routing, installedVersion, catalogVersion, installedArtifactSHA256, candidateArtifactSHA256 }).updateAvailable;
  // A newer version with another package is an update.
  assert.equal(project('0.6.4', '0.6.5', [installed], other), true);
  // The same package under another name is not: 0.6.4-alpha.1 → 0.6.4 (a promotion), 0.6.4 → 0.6.5 (a renamed build).
  assert.equal(project('0.6.4-alpha.1', '0.6.4', [installed], installed), false);
  assert.equal(project('0.6.4', '0.6.5', [installed], installed), false);
  // An older or the same version is never offered, whatever the package.
  assert.equal(project('0.6.5', '0.6.4', [installed], other), false);
  assert.equal(project('0.6.4', '0.6.4', [installed], other), false);
  assert.equal(project('0.6.4', '0.6.4-dev.3', [installed], other), false);
  // An app installed from the dev lane is newer than main's: back on main it keeps its version, nothing is offered,
  // until main has a newer one (YE-142 step 8).
  assert.equal(project('2026.11.20', '2026.11.1', [installed], other), false);
  assert.equal(project('1.4.0-rc.2', '1.3.9'), false);
  assert.equal(project('1.4.0-rc.2', '1.4.0'), true);
  // A dev build of the line before the market's stable name is offered the stable package (test boxes only).
  assert.equal(project('0.6.5-dev.1', '0.6.5', [installed], other), true);
  // The same package: the manifest decides, whatever the versions say (YE-194). The same manifest is no update, another
  // one is; without both digests it is none, as before.
  const projectManifest = (installedVersion: string, catalogVersion: string, installedManifestDigest?: string, candidateManifestDigest?: string) =>
    projectUpdateAvailability({ routing, installedVersion, catalogVersion, installedArtifactSHA256: [installed], candidateArtifactSHA256: installed,
      installedManifestDigest, candidateManifestDigest }).updateAvailable;
  assert.equal(projectManifest('0.6.4', '0.6.4', 'sha256:1', 'sha256:1'), false);
  assert.equal(projectManifest('0.6.4', '0.6.5', 'sha256:1', 'sha256:1'), false);
  assert.equal(projectManifest('0.6.4', '0.6.4', 'sha256:1', 'sha256:2'), true);
  assert.equal(projectManifest('0.6.4-alpha.1', '0.6.4', 'sha256:1', 'sha256:2'), true);
  assert.equal(projectManifest('0.6.4', '0.6.4', undefined, 'sha256:2'), false);
  // A container app is decided by version alone, whatever its manifest digests (YE-194 leaves it as it was).
  const container = (installedVersion: string, catalogVersion: string) => projectUpdateAvailability({ routing, installedVersion, catalogVersion,
    installedManifestDigest: 'sha256:1', candidateManifestDigest: 'sha256:2' }).updateAvailable;
  assert.equal(container('1.0.0', '1.0.0'), false);
  assert.equal(container('1.0.0', '1.1.0'), true);
  assert.equal(container('1.1.0', '1.0.0'), false);
  // A container app (no package) and a native app whose package is not known decide by version alone.
  assert.equal(project('1.0.0', '1.1.0'), true);
  assert.equal(project('0.6.4', '0.6.5', undefined, other), true);
  assert.equal(project('0.6.4', '0.6.5', [installed, other], installed), true, 'only every installed package equal is the same build');
});

test('Pointer without a recorded release or floor is never offered an older build (YE-141)', () => {
  const at = (iso: string) => Date.parse(iso) / 1000;
  const installedAt = '2026-10-01T12:00:00.000Z';
  // Native apps are Market apps since 0.6.20 (YE-142); Pointer keeps the channel's order (compareToInstalledNative).
  const project = (installedVersion: string, _version: string, line: string, sequence: number, extra: { installedKey?: { line: string; sequence: number } | null; installedAt?: string | null } = {}) =>
    compareToInstalledNative({
      key: extra.installedKey ?? null, artifactSHA256: ['a'.repeat(64)], version: installedVersion,
      installedAt: extra.installedAt === undefined ? installedAt : extra.installedAt,
    }, { key: { line, sequence }, artifactSHA256: 'b'.repeat(64) }) === 1;
  // Another line orders as the key would: an older line under another name is never offered, a newer one is.
  assert.equal(project('0.6.4-dev.2', '0.6.3', '0.6.3', at('2026-11-20T00:00:00Z')), false);
  assert.equal(project('0.6.4-dev.2', '0.6.5-alpha.1', '0.6.5', at('2026-09-01T00:00:00Z')), true);
  // The same line: a build published after the install record was created is newer (the installed one was published
  // before it was installed); one published before can't be ordered and is not offered, whatever its name.
  assert.equal(project('0.6.4-dev.2', '0.6.4', '0.6.4', at('2026-11-20T00:00:00Z')), true);
  assert.equal(project('0.6.4-dev.2', '0.6.4-dev.9', '0.6.4', at('2026-09-20T00:00:00Z')), false);
  assert.equal(project('0.6.4', '0.6.4-dev.1', '0.6.4', at('2026-10-01T12:00:00Z')), false);
  // Without an install time, or a readable installed name, nothing in the same line is offered.
  assert.equal(project('0.6.4-dev.2', '0.6.4', '0.6.4', at('2026-11-20T00:00:00Z'), { installedAt: null }), false);
  assert.equal(project('0.6.4-dev.2', '0.6.4', '0.6.4', at('2026-11-20T00:00:00Z'), { installedAt: 'not a time' }), false);
  assert.equal(project('custom', '0.6.5', '0.6.5', at('2026-11-20T00:00:00Z')), false);
  // A key (the recorded release, or the product floor when there is none) decides alone.
  assert.equal(project('0.6.4-dev.2', '0.6.4', '0.6.4', at('2026-11-20T00:00:00Z'), { installedKey: { line: '0.6.4', sequence: at('2026-11-21T00:00:00Z') } }), false);
  assert.equal(project('0.6.4-dev.2', '0.6.4-dev.1', '0.6.4', 100, { installedKey: { line: '0.6.4', sequence: 50 } }), true);
});

test('the installed key is the recorded release, else the product floor', async () => {
  const { installedNativeKey } = await import('../src/lib/releases/product-release');
  const floor = { line: '0.6.4', sequence: 1795082626, build: '0.6.4-dev.2', buildSHA256: 'a'.repeat(64), manifestSHA256: 'b'.repeat(64) };
  assert.deepEqual(installedNativeKey({ productReleaseFloors: { notes: floor } }, 'notes'), { line: '0.6.4', sequence: 1795082626 });
  // An old-shape floor (a build name only) has no key; neither has a record without floors or releases.
  assert.equal(installedNativeKey({ productReleaseFloors: { notes: { build: '0.6.4-dev.2', buildSHA256: 'a'.repeat(64), manifestSHA256: 'b'.repeat(64) } } }, 'notes'), null);
  assert.equal(installedNativeKey({ productReleaseFloors: { wiki: floor } }, 'notes'), null);
  assert.equal(installedNativeKey({}, 'notes'), null);
  assert.equal(installedNativeKey(null, 'notes'), null);
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
  const marketUpdates = read('src/app/api/market/updates/route.ts');
  const uiBridgeApps = read('src/app/api/ui-bridge/apps/route.ts');

  assert.match(settings, /handleMarketUpdate\(request, appId, 'json'\)/);
  assert.match(appRoute, /handleMarketUpdate\(req, name\)/);
  assert.match(compatibility, /handleMarketUpdate\(req\)/);
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

test('Pointer: an update to the installed build does nothing; the market updater decides by package, then version', () => {
  const key = (sequence: number) => ({ line: '0.6.4', sequence });
  const pkg = 'a'.repeat(64);
  assert.equal(compareToInstalledNative({ key: key(300) }, { key: key(300) }), 0);
  assert.equal(compareToInstalledNative({ key: key(300) }, { key: key(301) }), 1);
  // A recorded release decides; the package only speaks for an install without one.
  assert.equal(compareToInstalledNative({ key: null, artifactSHA256: [pkg] }, { key: key(301), artifactSHA256: pkg }), 0);
  // Without a key, the order (YE-141): an older line, or the same line published before the install, is refused.
  assert.equal(compareToInstalledNative({ version: '0.6.5-dev.1' }, { key: key(301) }), -1);
  assert.equal(compareToInstalledNative({ version: '0.6.3' }, { key: key(301) }), 1);
  assert.equal(compareToInstalledNative({ version: '0.6.4', installedAt: new Date(400_000).toISOString() }, { key: key(301) }), null);
  assert.equal(compareToInstalledNative({ version: '0.6.4', installedAt: new Date(200_000).toISOString() }, { key: key(301) }), 1);

  // The Market updater: a native app first takes a changed market manifest of its package (metadata only); then the
  // same package under the same manifest (or a lower version name than a Market record's, YE-212) is "already up to
  // date", another manifest of it goes on to the ordinary update, and another package is decided by version. There is no channel route any more (YE-142, YE-194).
  const market = read('src/lib/market/updater.ts');
  const adopt = market.indexOf('if (resolvedCatalog && nativeManifestChanged(installMeta, resolvedCatalog.reference.digest))');
  const same = market.indexOf('if (samePackage && (!nativeManifestChanged(installMeta, resolvedCatalog?.reference.digest) || olderMarketVersion(installMeta, targetVersion)))');
  const newer = market.indexOf('if (!samePackage && !isNewer(targetVersion, installedVersion))');
  assert.ok(adopt >= 0 && same > adopt && newer > same);
  assert.doesNotMatch(market, /resolveNativeProduct|routing\?\.kind === 'channel'|acceptProductSequence/);
});
