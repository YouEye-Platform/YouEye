// YE-142 step 6: a native app installed from the channel before 0.6.20 moves to its market. The records are the ones a
// 0.6.15 or 0.6.17 box holds (fixtures/native-records, from the real release documents): moved with no download, no
// restart and no deploy call when the market pins the same package; otherwise left alone, with the reason.
// YE-194: the same transaction (adoptNativeMarketManifest) takes a new manifest the market publishes for the package a
// Market native app runs; a new runtime configuration of that package stays offered as an ordinary update.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse as parseYAML, stringify } from 'yaml';
import { AppUpdateJournalStore } from '../src/lib/market/update-journal';
import { adoptNativeMarketManifest as moveNativeAppToMarket, isChannelInstalledNative, nativeManifestChanged, olderMarketVersion, type ReleaseMetadataIO } from '../src/lib/market/update-release-metadata';
import { loadApp } from '../src/lib/market/app-format/compile';
import { parseFrozenAppManifest } from '../src/lib/market/frozen-manifest';
import { projectUpdateAvailability } from '../src/lib/market/update-routing';
import type { InstallMetadata } from '../src/lib/market/types';
import type { InstalledApp } from '../src/lib/market/installed-apps';

const DIR = path.join(__dirname, 'fixtures/native-records');
const OFFICIAL = 'https://market.youeye.me/';
const COMMIT = '7a46ec1f0b3d';
const fixture = (name: string) => readFileSync(path.join(DIR, name), 'utf8');
/**
 * The records: app, the YouEye version that wrote them, the release tag they name. The first three were captured on
 * a test box (bykapc VM 380, 2026-11-24: installed at 0.6.15 from GitHub stable, updated to 0.6.16 and 0.6.18); the
 * last is built from the 0.6.17 tag code for an alpha box (a Forgejo receipt, a channel update recorded).
 */
const RECORDS = [['notes', '0.6.15', 'v0.6.4'], ['wiki', '0.6.16', 'v0.6.4'], ['search', '0.6.18', 'v0.6.4'], ['wiki', '0.6.17', 'v0.6.4-alpha.1']] as const;
const FAULTS = ['manifest', 'metadata', 'provenance', 'health', 'final-read'];

/**
 * The market's manifest of the app as `Tools/market/native-pin` writes it: the release's own youeye-app.yaml with the
 * stable version, `requires.youeye >=0.6.20` and `source.package`, read the way a box reads a market (strict).
 */
function marketManifest(app: string, tag: string, changes: (doc: Record<string, any>) => void = () => undefined) {
  const doc = parseYAML(fixture(`${app}-${tag}.youeye-app.yaml`)) as Record<string, any>;
  const release = JSON.parse(fixture(`${app}-${tag}.product-release.json`));
  const build = JSON.parse(Buffer.from(release.build_manifest_base64, 'base64').toString('utf8'));
  const tar = build.assets.find((asset: { name: string }) => asset.name === 'standalone.tar');
  const name = app[0].toUpperCase() + app.slice(1);
  doc.version = '0.6.4';
  doc.requires = { youeye: '>=0.6.20' };
  doc.source = { node: doc.source.node, package: { url: `https://github.com/YouEye-Platform/${name}/releases/download/v0.6.4/standalone.tar`, sha256: tar.sha256, size: tar.size_bytes } };
  changes(doc);
  const manifest = loadApp({ manifest: stringify(doc) }, { market: true });
  return { manifest, reference: { path: `apps/${app}/youeye-app.yaml`, repo: OFFICIAL, branch: COMMIT, digest: manifest.frozen!.digest } };
}

/** A box holding the records as files and rows hold them (JSON text), and the move's I/O over them. */
function box(app: string, writer: string, fault = 'none') {
  const state = {
    record: fixture(`${app}-${writer}.install.json`), registration: fixture(`${app}-${writer}.registration.json`),
    installed: JSON.parse(fixture(`${app}-${writer}.installed-app.json`)) as InstalledApp, effects: [] as string[],
    running: true, platform: '0.6.21',
  };
  const original = { record: state.record, registration: state.registration, installed: structuredClone(state.installed) };
  const record = () => JSON.parse(state.record) as InstallMetadata;
  const read = (version?: string) => parseFrozenAppManifest(state.registration, app, version, record().manifestDigest);
  let faulted = false;
  const after = (name: string) => {
    state.effects.push(name);
    if (fault === name && !faulted) { faulted = true; throw Error(`ambiguous ${name}`); }
  };
  let healthChecks = 0;
  const io: ReleaseMetadataIO = {
    metadata: async () => record(),
    save: async (m) => { state.record = JSON.stringify(m); after('metadata'); },
    installed: async () => structuredClone(state.installed),
    restoreInstalled: async (_, s) => { Object.assign(state.installed, s); },
    provenance: async () => { throw new Error('no channel release is recorded by a move'); },
    catalogProvenance: async (_, version) => {
      Object.assign(state.installed, { installedVersion: version, catalogVersion: version, installedTag: null, installedBranch: null,
        channelSource: null, candidateVersion: null, candidateBranch: null, candidateTag: null, updateAvailable: false, switchPending: false });
      after('provenance');
    },
    manifest: async (_, version) => { const m = read(version); if (version === '0.6.4' && state.effects.includes('provenance')) after('final-read'); return m; },
    syncManifest: async (_, m) => { state.registration = JSON.stringify(m); after('manifest'); },
    verifyProjection: async () => { throw new Error('a move never touches the runtime'); },
    publishProjection: async () => { throw new Error('a move never touches the runtime'); },
    // The first check is the quiesce, before anything is written; the second follows the apply.
    health: async () => { if (++healthChecks % 2 === 0) after('health'); },
    running: async () => state.running,
    platformVersion: async () => state.platform,
  };
  return { state, original, record, read, io, before: record() };
}

async function withStore(run: (store: AppUpdateJournalStore) => Promise<void>) {
  const root = mkdtempSync(path.join(tmpdir(), 'ye-native-move-'));
  try { await run(new AppUpdateJournalStore(root)); } finally { rmSync(root, { recursive: true, force: true }); }
}

test('real 0.6.15, 0.6.16 and 0.6.18 records (and a built 0.6.17 alpha one) are channel-shaped; a market record is not', () => {
  for (const [app, writer] of RECORDS) assert.equal(isChannelInstalledNative(JSON.parse(fixture(`${app}-${writer}.install.json`))), true, app);
  assert.equal(isChannelInstalledNative({ integration: 'native', manifestPath: 'apps/notes/youeye-app.yaml',
    nativeArtifacts: [{ verification: 'manifest' } as never] }), false);
  assert.equal(isChannelInstalledNative({ integration: 'basic', manifestPath: 'youeye-app.yaml' }), false);
  assert.equal(isChannelInstalledNative(null), false);
});

test('the same package moves to the market: record and copy only, no download, no restart, no deploy', async (t) => {
  for (const [app, writer, tag] of RECORDS) await t.test(`${app} (written by ${writer})`, () => withStore(async (store) => {
    const b = box(app, writer);
    const market = marketManifest(app, tag);
    const installedCopy = b.read();
    const outcome = await moveNativeAppToMarket(store, b.before, b.state.installed, market.manifest, market.reference, b.io);
    assert.deepEqual(outcome, { moved: true, previousVersion: b.before.installedVersion, version: '0.6.4', fromChannel: true });
    assert.deepEqual(b.state.effects, ['manifest', 'metadata', 'provenance', 'health', 'final-read'], 'registration, record and state only');
    const journal = store.list()[0];
    assert.equal(journal.operationKind, 'release-metadata');
    assert.ok(journal.commit && journal.cleanupComplete);
    assert.ok(journal.resources.every((resource) => !resource.mutable || resource.kind === 'metadata'), 'no container is a mutable resource');

    const record = b.record(), before = b.before;
    assert.equal(record.manifestPath, `apps/${app}/youeye-app.yaml`);
    assert.equal(record.manifestRepo, OFFICIAL);
    assert.equal(record.manifestBranch, COMMIT);
    assert.equal(record.manifestDigest, market.manifest.frozen!.digest);
    assert.equal(record.installedVersion, '0.6.4');
    assert.deepEqual(record.nativeArtifacts, [{
      containerName: 'main', sourceRepo: market.manifest.containers.find((c) => c.type === 'lxd')!.source!.package!.url, releaseTag: '0.6.4',
      version: '0.6.4', artifactName: 'standalone.tar', sha256: before.nativeArtifacts![0].sha256, bytes: before.nativeArtifacts![0].bytes,
      verification: 'manifest',
    }]);
    // Everything else stays: the source identity, the installation, the sign-in client, the database, the old floors.
    const unchanged = (m: InstallMetadata) => {
      const { manifestPath: _p, manifestRepo: _r, manifestBranch: _b, manifestDigest: _d, installedVersion: _v, nativeArtifacts: _n, ...rest } = m;
      return rest;
    };
    assert.deepEqual(unchanged(record), unchanged(before));
    assert.equal(record.sourceId, 'official');
    assert.equal(record.catalogKey, `official:app:${app}`);
    assert.deepEqual(record.productReleaseFloors, before.productReleaseFloors, 'old floors are left, unread');
    // installed-apps.json: the market version, no channel tag or repository, no update.
    assert.equal(b.state.installed.installedVersion, '0.6.4');
    assert.equal(b.state.installed.installedTag, null);
    assert.equal(b.state.installed.channelSource, null);
    assert.equal(b.state.installed.updateAvailable, false);
    assert.equal(b.state.installed.sourceId, 'official');
    // The dashboard's frozen copy is the market's, and reads back against the record.
    const copy = b.read('0.6.4');
    assert.equal(copy.frozen!.manifest, market.manifest.frozen!.manifest);
    assert.equal(copy.containers[0].source?.package?.sha256, before.nativeArtifacts![0].sha256);
    assert.deepEqual(copy.env_mapping, installedCopy.env_mapping);
    assert.deepEqual(copy.sso, installedCopy.sso);
    // Then: the same package is no update, and a second move has nothing to do.
    assert.equal(projectUpdateAvailability({ routing: { kind: 'catalog', reason: 'recorded-external-catalog' }, installedVersion: record.installedVersion,
      installedArtifactSHA256: record.nativeArtifacts!.map((a) => a.sha256), catalogVersion: '0.6.4',
      candidateArtifactSHA256: market.reference && market.manifest.containers[0].source!.package!.sha256,
      installedManifestDigest: record.manifestDigest, candidateManifestDigest: market.reference.digest }).updateAvailable, false);
    assert.equal(nativeManifestChanged(record, market.reference.digest), false);
    assert.deepEqual(await moveNativeAppToMarket(store, record, b.state.installed, market.manifest, market.reference, b.io),
      { moved: false, reason: 'same-manifest', detail: `${app} already runs the market's manifest` });
  }));
});

test('another package, another runtime configuration or a stopped app is not moved, and nothing changes', async (t) => {
  for (const [app, writer, tag] of RECORDS) await t.test(app, () => withStore(async (store) => {
    const cases: Array<[string, (doc: Record<string, any>) => void, string, () => void]> = [
      ['package-differs', (doc) => { doc.version = '0.6.5'; doc.source.package.sha256 = 'f'.repeat(64); }, 'is another package', () => undefined],
      ['contract-differs', (doc) => { doc.env = { ...doc.env, EXTRA: '1' }; }, 'configures the app differently', () => undefined],
      ['contract-differs', (doc) => { doc.port = 3001; }, 'configures the app differently', () => undefined],
      ['stopped', () => undefined, 'is stopped', () => undefined],
    ];
    for (const [reason, change, detail] of cases) {
      const b = box(app, writer);
      if (reason === 'stopped') b.state.running = false;
      const market = marketManifest(app, tag, change);
      const outcome = await moveNativeAppToMarket(store, b.before, b.state.installed, market.manifest, market.reference, b.io);
      assert.equal(outcome.moved, false);
      assert.equal((outcome as { reason: string }).reason, reason);
      assert.match((outcome as { detail: string }).detail, new RegExp(detail));
      assert.equal(b.state.record, b.original.record);
      assert.equal(b.state.registration, b.original.registration);
      assert.deepEqual(b.state.installed, b.original.installed);
      assert.deepEqual(b.state.effects, []);
    }
    assert.equal(store.list().length, 0, 'no operation was started');
    // A listing-only change (text, pictures) moves: it is not what the app runs.
    const b = box(app, writer);
    const listed = marketManifest(app, tag, (doc) => { doc.listing = { ...doc.listing, description: 'Another text', screenshots: undefined }; });
    assert.equal((await moveNativeAppToMarket(store, b.before, b.state.installed, listed.manifest, listed.reference, b.io)).moved, true);
  }));
});

test('a fault at any step of the move rolls back to the channel record, verified; the next check moves it', async (t) => {
  for (const [app, writer, tag] of RECORDS.slice(0, 2)) for (const fault of FAULTS) await t.test(`${app}: ${fault}`, () => withStore(async (store) => {
    const b = box(app, writer, fault);
    const market = marketManifest(app, tag);
    await assert.rejects(moveNativeAppToMarket(store, b.before, b.state.installed, market.manifest, market.reference, b.io), new RegExp(`ambiguous ${fault}`));
    const journal = store.list()[0];
    assert.equal(journal.phase, 'cleanup');
    assert.equal(!!journal.commit, false);
    assert.ok(journal.rollbackVerifiedAt, 'the rollback was verified');
    assert.deepEqual(b.record(), JSON.parse(b.original.record));
    // The installed-app state comes back field for field; an update field the entry never had comes back as null
    // (restoreInstalledAppUpdateState writes every one of them; absent and null mean the same to every reader).
    const UPDATE_FIELDS = ['installedVersion', 'catalogVersion', 'updateAvailable', 'switchPending', 'installedTag', 'installedBranch',
      'channelSource', 'candidateVersion', 'candidateBranch', 'candidateTag'];
    const filled = (app: object) => ({ ...Object.fromEntries(UPDATE_FIELDS.map((key) => [key, null])), ...app });
    assert.deepEqual(filled(b.state.installed), filled(b.original.installed));
    assert.deepEqual(b.read(), parseFrozenAppManifest(b.original.registration, app, undefined, b.before.manifestDigest));
    const again = await moveNativeAppToMarket(store, b.record(), b.state.installed, market.manifest, market.reference, b.io);
    assert.equal(again.moved, true);
  }));
});

test('the market copy as the catalog hands it over (pictures on this box\'s image route) moves and reads back (review)', async (t) => {
  for (const [app, writer, tag] of RECORDS) await t.test(app, () => withStore(async (store) => {
    const b = box(app, writer);
    const market = marketManifest(app, tag);
    // catalog.ts resolveManifestPaths: the icon and screenshots become this box's image route, or go when the bundle
    // has no file for them. The installed copy is rebuilt from the frozen text, which names them as the manifest does.
    const resolved = structuredClone(market.manifest);
    resolved.metadata.iconUrl = `/api/market/image?source=official&file=${encodeURIComponent(`h/files/${'e'.repeat(64)}.svg`)}`;
    if (resolved.detail) resolved.detail.screenshots = resolved.detail.screenshots.slice(0, 1)
      .map((shot) => ({ ...shot, path: `/api/market/image?source=official&file=${encodeURIComponent(`h/files/${'f'.repeat(64)}.png`)}` }));
    const outcome = await moveNativeAppToMarket(store, b.before, b.state.installed, resolved, market.reference, b.io);
    assert.equal(outcome.moved, true, JSON.stringify(outcome));
    assert.equal(store.list()[0].commit !== undefined, true);
    assert.equal(b.read('0.6.4').frozen!.digest, market.manifest.frozen!.digest);
  }));
});

test('a recorded package that does not fit the market\'s container is no move, not a failure (review)', () => withStore(async (store) => {
  const b = box('notes', '0.6.15');
  const market = marketManifest('notes', 'v0.6.4');
  const before = { ...b.before, nativeArtifacts: [{ ...b.before.nativeArtifacts![0], containerName: 'other' }] };
  const outcome = await moveNativeAppToMarket(store, before, b.state.installed, market.manifest, market.reference, b.io);
  assert.deepEqual([outcome.moved, (outcome as { reason: string }).reason], [false, 'contract-differs']);
  assert.equal(store.list().length, 0);
}));

/** The box after the move: a Market native app (record, registration and state as the move left them). */
async function movedBox(store: AppUpdateJournalStore, app: string, writer: string, tag: string) {
  const b = box(app, writer);
  const market = marketManifest(app, tag);
  assert.equal((await moveNativeAppToMarket(store, b.before, b.state.installed, market.manifest, market.reference, b.io)).moved, true);
  b.state.effects.length = 0;
  const moved = { record: b.state.record, registration: b.state.registration, installed: structuredClone(b.state.installed) };
  const project = (candidate: ReturnType<typeof marketManifest>) => projectUpdateAvailability({
    routing: { kind: 'catalog', reason: 'recorded-external-catalog' }, installedVersion: b.record().installedVersion,
    installedArtifactSHA256: b.record().nativeArtifacts!.map((a) => a.sha256), catalogVersion: candidate.manifest.version,
    candidateArtifactSHA256: candidate.manifest.containers.find((c) => c.type === 'lxd')!.source!.package!.sha256,
    installedManifestDigest: b.record().manifestDigest, candidateManifestDigest: candidate.reference.digest,
    marketRecord: !isChannelInstalledNative(b.record()),
  }).updateAvailable;
  return { ...b, market, moved, project };
}
const NEXT_COMMIT = '9c0d1e2f3a4b';
const republished = (app: string, tag: string, change: (doc: Record<string, any>) => void) => {
  const next = marketManifest(app, tag, change);
  return { ...next, reference: { ...next.reference, branch: NEXT_COMMIT } };
};

test('YE-194: a new market manifest for the package a Market native app runs is taken, metadata only, no restart', async (t) => {
  const changes: Array<[string, string, (doc: Record<string, any>) => void]> = [
    ['a requirement fix, same version', '0.6.4', (doc) => { doc.requires = { youeye: '>=0.6.21' }; }],
    ['a new version name and requirement', '0.6.5', (doc) => { doc.version = '0.6.5'; doc.requires = { youeye: '>=0.6.21' }; }],
  ];
  for (const [app, writer, tag] of RECORDS) for (const [label, version, change] of changes) await t.test(`${app}: ${label}`, () => withStore(async (store) => {
    const b = await movedBox(store, app, writer, tag);
    const next = republished(app, tag, change);
    assert.notEqual(next.reference.digest, b.market.reference.digest);
    // Before: the check sees a changed manifest for the same package (it was "already up to date" before YE-194).
    assert.equal(nativeManifestChanged(b.record(), next.reference.digest), true);
    assert.equal(b.project(next), true);
    const outcome = await moveNativeAppToMarket(store, b.record(), b.state.installed, next.manifest, next.reference, b.io);
    assert.deepEqual(outcome, { moved: true, previousVersion: '0.6.4', version, fromChannel: false });
    // Registration, record and state only: no projection, no deploy, the app's runtime is only asked for its health.
    assert.deepEqual(b.state.effects.filter((e) => e !== 'final-read'), ['manifest', 'metadata', 'provenance', 'health']);
    const journals = store.list();
    assert.equal(journals.length, 2);
    assert.ok(journals.every((j) => j.operationKind === 'release-metadata' && j.commit && j.cleanupComplete));
    const record = b.record(), before = JSON.parse(b.moved.record) as InstallMetadata;
    assert.equal(record.manifestDigest, next.reference.digest);
    assert.equal(record.manifestBranch, NEXT_COMMIT);
    assert.equal(record.installedVersion, version);
    assert.deepEqual(record.nativeArtifacts!.map((a) => [a.sha256, a.bytes, a.verification, a.version]),
      before.nativeArtifacts!.map((a) => [a.sha256, a.bytes, 'manifest', version]));
    const rest = (m: InstallMetadata) => {
      const { manifestBranch: _b, manifestDigest: _d, installedVersion: _v, nativeArtifacts: _n, ...other } = m;
      return other;
    };
    assert.deepEqual(rest(record), rest(before), 'credentials, source identity and containers stay');
    assert.equal(b.read(version).frozen!.manifest, next.manifest.frozen!.manifest, 'the dashboard copy is the new manifest');
    assert.equal(b.state.installed.installedVersion, version);
    // After: up to date, and nothing more to take.
    assert.equal(b.project(next), false);
    assert.equal((await moveNativeAppToMarket(store, record, b.state.installed, next.manifest, next.reference, b.io) as { reason: string }).reason, 'same-manifest');
  }));
});

test('YE-194: the same package under the same manifest is up to date; a new runtime configuration is offered, not taken', async (t) => {
  for (const [app, writer, tag] of RECORDS) await t.test(app, () => withStore(async (store) => {
    const b = await movedBox(store, app, writer, tag);
    // The same manifest, from another market commit, or with only its listing changed (the digest leaves `listing:`
    // out: store text is the market's, read from it): nothing to do, nothing offered.
    for (const same of [{ ...b.market, reference: { ...b.market.reference, branch: NEXT_COMMIT } },
      republished(app, tag, (doc) => { doc.listing = { ...doc.listing, description: 'Another text' }; })]) {
      assert.equal(same.reference.digest, b.market.reference.digest);
      assert.equal(b.project(same), false);
      assert.equal((await moveNativeAppToMarket(store, b.record(), b.state.installed, same.manifest, same.reference, b.io) as { reason: string }).reason, 'same-manifest');
    }
    // A new runtime configuration of the same package: not a metadata change. The record stays, and the check offers
    // it as an update (the ordinary update restarts the app with it).
    const reconfigured = republished(app, tag, (doc) => { doc.env = { ...doc.env, EXTRA: '1' }; });
    const outcome = await moveNativeAppToMarket(store, b.record(), b.state.installed, reconfigured.manifest, reconfigured.reference, b.io);
    assert.deepEqual([outcome.moved, (outcome as { reason: string }).reason], [false, 'contract-differs']);
    assert.equal(b.state.record, b.moved.record);
    assert.equal(b.state.registration, b.moved.registration);
    assert.deepEqual(b.state.installed, b.moved.installed);
    assert.deepEqual(b.state.effects, []);
    assert.equal(store.list().length, 1, 'only the move ran');
    assert.equal(b.project(reconfigured), true);
    // Another package is decided by version, as before.
    const newer = republished(app, tag, (doc) => { doc.version = '0.6.5'; doc.source.package.sha256 = 'f'.repeat(64); });
    assert.equal(b.project(newer), true);
    const renamedOlder = republished(app, tag, (doc) => { doc.version = '0.6.3'; doc.source.package.sha256 = 'f'.repeat(64); });
    assert.equal(b.project(renamedOlder), false);
  }));
});

test('YE-194: a fault while taking a new manifest rolls back to the Market record before it, verified', async (t) => {
  for (const fault of FAULTS.filter((f) => f !== 'final-read')) await t.test(fault, () => withStore(async (store) => {
    const b = await movedBox(store, 'notes', '0.6.15', 'v0.6.4');
    const next = republished('notes', 'v0.6.4', (doc) => { doc.version = '0.6.5'; });
    const faulty = box('notes', '0.6.15', fault);
    Object.assign(faulty.state, { record: b.state.record, registration: b.state.registration, installed: structuredClone(b.state.installed) });
    await assert.rejects(moveNativeAppToMarket(store, faulty.record(), faulty.state.installed, next.manifest, next.reference, faulty.io), new RegExp(`ambiguous ${fault}`));
    const journal = store.list().find((j) => !j.commit)!;
    assert.ok(journal.rollbackVerifiedAt, 'the rollback was verified');
    assert.deepEqual(faulty.record(), JSON.parse(b.moved.record));
    assert.equal(faulty.read('0.6.4').frozen!.digest, b.market.reference.digest);
    assert.equal(faulty.state.installed.installedVersion, '0.6.4');
    const again = await moveNativeAppToMarket(store, faulty.record(), faulty.state.installed, next.manifest, next.reference, faulty.io);
    assert.equal(again.moved, true);
  }));
});

/** Nothing of the box changed and no operation started (the move's own journal aside). */
function unchanged(b: Awaited<ReturnType<typeof movedBox>> | ReturnType<typeof box>, journals: number, store: AppUpdateJournalStore) {
  const kept = 'moved' in b ? b.moved : b.original;
  assert.equal(b.state.record, kept.record);
  assert.equal(b.state.registration, kept.registration);
  assert.deepEqual(b.state.installed, kept.installed);
  assert.deepEqual(b.state.effects, []);
  assert.equal(store.list().length, journals);
}

test('YE-212: a manifest whose requires.youeye the box does not meet is not adopted until the box meets it', async (t) => {
  for (const [app, writer, tag] of RECORDS) await t.test(app, () => withStore(async (store) => {
    // A channel record (before 0.6.20) whose market needs a newer YouEye stays on its channel record.
    const channel = box(app, writer);
    const future = marketManifest(app, tag, (doc) => { doc.requires = { youeye: '>=9.0.0' }; });
    const refused = await moveNativeAppToMarket(store, channel.before, channel.state.installed, future.manifest, future.reference, channel.io);
    assert.deepEqual([refused.moved, (refused as { reason: string }).reason], [false, 'needs-youeye']);
    assert.match((refused as { detail: string }).detail, /needs YouEye ≥ 9\.0\.0; this box runs 0\.6\.21/);
    unchanged(channel, 0, store);
    // A Market record: the new manifest (same package, same runtime) waits too; the update is not offered.
    const b = await movedBox(store, app, writer, tag);
    const next = republished(app, tag, (doc) => { doc.version = '0.6.5'; doc.requires = { youeye: '>=9.0.0' }; });
    const outcome = await moveNativeAppToMarket(store, b.record(), b.state.installed, next.manifest, next.reference, b.io);
    assert.deepEqual([outcome.moved, (outcome as { reason: string }).reason], [false, 'needs-youeye']);
    unchanged(b, 1, store);
    assert.equal(b.read('0.6.4').frozen!.digest, b.market.reference.digest, 'the frozen copy is still the one the record names');
    // Once the box runs YouEye 9.0.0 (a YouEye update restarts the Control Panel, and the check tries again) it is taken.
    b.state.platform = '9.0.0';
    const taken = await moveNativeAppToMarket(store, b.record(), b.state.installed, next.manifest, next.reference, b.io);
    assert.deepEqual(taken, { moved: true, previousVersion: '0.6.4', version: '0.6.5', fromChannel: false });
    assert.equal(b.record().manifestDigest, next.reference.digest);
    channel.state.platform = '9.0.0';
    assert.equal((await moveNativeAppToMarket(store, channel.before, channel.state.installed, future.manifest, future.reference, channel.io)).moved, true);
  }));
});

test('YE-212: a lower version name for the package a Market record runs is neither taken nor offered; a channel record still moves', async (t) => {
  for (const [app, writer, tag] of RECORDS) await t.test(app, () => withStore(async (store) => {
    const b = await movedBox(store, app, writer, tag);
    const older = republished(app, tag, (doc) => { doc.version = '0.6.3'; doc.requires = { youeye: '>=0.6.21' }; });
    assert.equal(nativeManifestChanged(b.record(), older.reference.digest), true);
    const outcome = await moveNativeAppToMarket(store, b.record(), b.state.installed, older.manifest, older.reference, b.io);
    assert.deepEqual([outcome.moved, (outcome as { reason: string }).reason], [false, 'older-version']);
    assert.match((outcome as { detail: string }).detail, /0\.6\.3 is older than the installed 0\.6\.4/);
    unchanged(b, 1, store);
    assert.equal(olderMarketVersion(b.record(), '0.6.3'), true);
    assert.equal(b.project(older), false, 'not offered as an update either');
    // The same version name is not older: a requirement fix under it is taken (YE-194).
    assert.equal(olderMarketVersion(b.record(), '0.6.4'), false);
    // A channel record names a channel release (another scheme, YE-142): a lower market name does not keep it there.
    const channel = box(app, writer);
    assert.equal(olderMarketVersion(channel.before, '0.0.1'), false);
    const lower = marketManifest(app, tag, (doc) => { doc.version = '0.0.1'; });
    assert.equal((await moveNativeAppToMarket(store, channel.before, channel.state.installed, lower.manifest, lower.reference, channel.io)).moved, true);
  }));
});
