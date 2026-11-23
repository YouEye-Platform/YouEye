import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  catalogUpdateState,
  classifyAppUpdateRouting,
  compareToInstalledNative,
  isInstalledNativeBuild,
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

test('native channel candidates are ordered by line and sequence, never by release name', () => {
  const routing = { kind: 'channel' as const, reason: 'native-app' as const };
  const key = (version: string, sequence: number) => ({ line: version.replace(/-.*/, ''), sequence });
  const project = (installedVersion: string, installedSequence: number | null, version: string, sequence: number) => projectUpdateAvailability({
    routing, installedVersion, installedKey: installedSequence === null ? null : key(installedVersion, installedSequence),
    catalogVersion: null, candidate: { version, tag: `v${version}`, key: key(version, sequence) },
  });
  const behind = project('0.6.2-dev.1', 500, '0.6.1-dev.4', 400);
  assert.equal(behind.updateAvailable, false);
  assert.equal(behind.switchPending, false);
  const ahead = project('0.6.1-dev.4', 400, '0.6.2-dev.1', 500);
  assert.equal(ahead.updateAvailable, true);
  assert.equal(ahead.candidateTag, 'v0.6.2-dev.1');
  // A newer build under a promoted name is an update; an older build named "0.6.1" is not.
  assert.equal(project('0.6.1-dev.2', 200, '0.6.1-alpha.1', 300).updateAvailable, true);
  assert.equal(project('0.6.1-alpha.1', 300, '0.6.1', 200).updateAvailable, false);
  // Labels never decide: alpha.2 of an older build is not newer than dev.1 of a newer one.
  assert.equal(project('0.6.1-dev.1', 300, '0.6.1-alpha.2', 200).updateAvailable, false);
  // The same build under another name is no update (YE-139): the installed name stays.
  const renamed = project('0.6.4', 300, '0.6.4-alpha.1', 300);
  assert.equal(renamed.updateAvailable, false);
  assert.equal(renamed.switchPending, false);
  assert.equal(project('0.6.1-alpha.1', 300, '0.6.1-beta.1', 300).updateAvailable, false);
  assert.equal(project('0.6.1-beta.1', 300, '0.6.1-beta.1', 300).updateAvailable, false);
  // No recorded release and nothing else known in the same line: never offered, it could be older (YE-141).
  assert.equal(project('0.6.1-dev.9', null, '0.6.1-dev.1', 100).updateAvailable, false);
  assert.equal(project('0.6.4-dev.2', null, '0.6.4-dev.2', 100).updateAvailable, false);
});

test('a native app without a recorded release is decided by its package when it is known (YE-139)', () => {
  const routing = { kind: 'channel' as const, reason: 'native-app' as const };
  const installed = 'a'.repeat(64), other = 'b'.repeat(64);
  const project = (installedArtifactSHA256: string[] | undefined, artifactSHA256: string | undefined, version = '0.6.4-alpha.1') =>
    projectUpdateAvailability({
      routing, installedVersion: '0.6.4', installedKey: null, installedArtifactSHA256, catalogVersion: null,
      candidate: { version, tag: `v${version}`, key: { line: '0.6.4', sequence: 300 }, artifactSHA256 },
    }).updateAvailable;
  // The installed package under another name: the same build, no update.
  assert.equal(project([installed], installed), false);
  assert.equal(project([installed, installed], installed), false);
  // Another package in the same line, with nothing that orders it: not offered (YE-141, it could be older).
  assert.equal(project([installed], other), false);
  assert.equal(project([installed, other], installed), false);
  assert.equal(project(undefined, installed), false);
  assert.equal(project([], installed), false);
  assert.equal(project([installed], undefined), false);
  assert.equal(project([installed], undefined, '0.6.4'), false);
});

test('a native app without a recorded release or floor is never offered an older build (YE-141)', () => {
  const routing = { kind: 'channel' as const, reason: 'native-app' as const };
  const at = (iso: string) => Date.parse(iso) / 1000;
  const installedAt = '2026-10-01T12:00:00.000Z';
  const project = (installedVersion: string, version: string, line: string, sequence: number, extra: { installedKey?: { line: string; sequence: number } | null; installedAt?: string | null } = {}) =>
    projectUpdateAvailability({
      routing, installedVersion, installedKey: extra.installedKey ?? null, installedArtifactSHA256: ['a'.repeat(64)],
      installedAt: extra.installedAt === undefined ? installedAt : extra.installedAt, catalogVersion: null,
      candidate: { version, tag: `v${version}`, key: { line, sequence }, artifactSHA256: 'b'.repeat(64) },
    }).updateAvailable;
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

test('same build with a recorded release: no update whatever the packages say', () => {
  const routing = { kind: 'channel' as const, reason: 'native-app' as const };
  const result = projectUpdateAvailability({
    routing, installedVersion: '0.6.4', installedKey: { line: '0.6.4', sequence: 300 }, installedArtifactSHA256: ['a'.repeat(64)],
    catalogVersion: null, candidate: { version: '0.6.5-alpha.1', tag: 'v0.6.5-alpha.1', key: { line: '0.6.5', sequence: 310 }, artifactSHA256: 'a'.repeat(64) },
  });
  // A newer key is an update even with the same package (a rebuild that changed nothing is adopted without a restart).
  assert.equal(result.updateAvailable, true);
  assert.equal(result.candidateVersion, '0.6.5-alpha.1');
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

test('an update to the installed build does nothing and keeps the installed name (YE-139)', () => {
  const key = (sequence: number) => ({ line: '0.6.4', sequence });
  const pkg = 'a'.repeat(64);
  assert.equal(isInstalledNativeBuild({ key: key(300) }, { key: key(300) }), true);
  assert.equal(isInstalledNativeBuild({ key: key(300) }, { key: key(301) }), false);
  // A recorded release decides; the package only speaks for an install without one.
  assert.equal(isInstalledNativeBuild({ key: key(300), artifactSHA256: [pkg] }, { key: key(301), artifactSHA256: pkg }), false);
  assert.equal(isInstalledNativeBuild({ key: null, artifactSHA256: [pkg] }, { key: key(301), artifactSHA256: pkg }), true);
  assert.equal(isInstalledNativeBuild({ key: null, artifactSHA256: [pkg] }, { key: key(301), artifactSHA256: 'b'.repeat(64) }), false);
  assert.equal(isInstalledNativeBuild({ key: null }, { key: key(301) }), false);
  // Without a key, the order (YE-141): an older line, or the same line published before the install, is refused.
  assert.equal(compareToInstalledNative({ version: '0.6.5-dev.1' }, { key: key(301) }), -1);
  assert.equal(compareToInstalledNative({ version: '0.6.3' }, { key: key(301) }), 1);
  assert.equal(compareToInstalledNative({ version: '0.6.4', installedAt: new Date(400_000).toISOString() }, { key: key(301) }), null);
  assert.equal(compareToInstalledNative({ version: '0.6.4', installedAt: new Date(200_000).toISOString() }, { key: key(301) }), 1);

  // The updaters stop there: after the floor (an older build or other contents under the key are still refused) and
  // before the label-only adoption, which stays for a newer key with the same payload.
  const market = read('src/lib/market/updater.ts');
  const floor = market.indexOf('acceptProductSequence(installMeta.productReleaseFloors');
  const order = market.indexOf('buildOrder = compareToInstalledNative(');
  const refused = market.indexOf('if (buildOrder === null || buildOrder < 0)');
  const same = market.indexOf('if (buildOrder === 0 ||');
  const adopt = market.indexOf('updateIdenticalProductRelease(appUpdateJournalStore()');
  assert.ok(floor >= 0 && order > floor && refused > order && same > refused && adopt > same);
  // Without a floor or a recorded release an older build, or one it can't order, is refused before anything changes.
  assert.match(market.slice(refused, same), /throw new Error\(buildOrder === null[\s\S]{0,300}waiting for a newer build[\s\S]{0,200}waiting for the channel to catch up/);
  assert.match(market.slice(same, adopt), /already up to date \(\$\{installedVersion\}\)[\s\S]{0,200}unchanged: true/);
  const pointer = read('src/lib/apps/lxd-updater.ts');
  const pointerFloor = pointer.indexOf('acceptProductSequence(before.floors, selected, installed);');
  const pointerSame = pointer.indexOf('compareReleases(selected.release, installed.release) === 0');
  const pointerAdopt = pointer.indexOf('updateIdenticalPointerRelease(appUpdateJournalStore()');
  assert.ok(pointerFloor >= 0 && pointerSame > pointerFloor && pointerAdopt > pointerSame);
  // Without a recorded release, Pointer's updater decides by the package as pointerUpdateState does: the same
  // standalone.tar as the legacy provenance record is up to date, before the adoption or any container change.
  const pointerLegacy = pointer.indexOf("const legacy = await getCoreProvenance('app:pointer');");
  assert.ok(pointerLegacy > pointerSame && pointerAdopt > pointerLegacy);
  assert.match(pointer.slice(pointerLegacy, pointerAdopt),
    /const order = compareToInstalledNative\([\s\S]{0,500}if \(order === 0\) \{[\s\S]{0,150}already up to date \(\$\{legacy\.version\}\)[\s\S]{0,80}return;[\s\S]{0,80}if \(order === null \|\| order < 0\) \{\s*throw new Error/);
  assert.ok(pointer.indexOf('containerState(containerName)') > pointerLegacy, 'decided before a stopped Pointer is started');
  assert.ok(pointer.indexOf("createSnapshot(containerName") > pointerAdopt);
});
