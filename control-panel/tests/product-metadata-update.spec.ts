import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AppUpdateJournalStore } from '../src/lib/market/update-journal';
import { AppUpdateTransaction } from '../src/lib/market/update-transaction';
import { ReleaseMetadataUpdateProvider, updateIdenticalProductRelease, type ReleaseMetadataIO } from '../src/lib/market/update-release-metadata';
import { nativeManifestFromContract, nativeManifestReference } from '../src/lib/market/native-artifact';
import { parseFrozenAppManifest } from '../src/lib/market/frozen-manifest';
import { productReceipt, productTag, verifyProductRelease, acceptProductSequence } from '../src/lib/releases/product-release';
import { productFixture } from './fixtures/release-fixtures';
import type { InstallMetadata } from '../src/lib/market/types';
import type { InstalledApp } from '../src/lib/market/installed-apps';

const hash = (raw: Buffer | string) => createHash('sha256').update(raw).digest('hex');
// `fixtures/native-apps/<id>.yaml`: the six native apps' `youeye-app.yaml`, copied from their repositories (2026-11-20).
const APPS = ['notes', 'wiki', 'search', 'translate', 'weather', 'cinema'];
const FAULTS = ['projection', 'manifest', 'metadata', 'provenance', 'verification', 'health', 'final-read'];
const OLD = '0.6.4-dev.2', NEW = '0.6.4';

/**
 * A box with one installed native app, stored as on a real box: the registration (`youeye_ui.apps.manifest`) and the
 * install record are JSON text, and the installed manifest is read back the way `readFrozenUpdateManifest` reads it
 * (rebuilt from the registration's frozen source, checked against the record's digest and the asked version).
 */
async function box(app: string, fault = 'none') {
  const contract = readFileSync(path.join(__dirname, 'fixtures/native-apps', `${app}.yaml`));
  const source = `https://github.com/YouEye-Platform/${app}`;
  const payload = Buffer.from(`${app} standalone.tar`);
  const base = productFixture(app, OLD, source, {'standalone.tar':payload}, {contract, clean:true});
  // One build under two release names (a promotion), and another build of the same contract.
  function release(version: string, from = base) {
    const r = {...from.release, version, tag:productTag(version)};
    return verifyProductRelease(Buffer.from(JSON.stringify(r)), {product:app, repository:source, tag:r.tag});
  }
  const old = release(OLD), selected = release(NEW);
  const rebuilt = release(NEW, productFixture(app, OLD, source, {'standalone.tar':Buffer.from('another build')}, {contract, clean:true}));
  // What an install of the old release stores, and what an update to the new one is given.
  const installedManifest = await nativeManifestFromContract(contract, old);
  const candidate = await nativeManifestFromContract(contract, selected);
  const container = `app-${app}`;
  const before = {appId:app, installedVersion:OLD, serviceCredentialState:'ready', domain:'old.test',
    containers:[{name:'main', containerName:container, type:'lxd'}],
    manifestPath:'youeye-app.yaml', manifestRepo:source, manifestBranch:old.release.tag, manifestDigest:installedManifest.frozen!.digest,
    nativeArtifacts:[{containerName:'main', sourceRepo:source, releaseTag:old.release.tag, version:OLD, artifactName:'standalone.tar',
      sha256:hash(payload), bytes:payload.length, verification:'product-release', productReleaseSHA256:old.manifestSHA256,
      productRelease:productReceipt(old), runtimeUUID:'12345678-1234-1234-1234-123456789012'}],
    productReleaseFloors:acceptProductSequence(undefined, old)} as unknown as InstallMetadata;
  const installed = {installedVersion:OLD, installedTag:old.release.tag, installedBranch:null, channelSource:source, updateAvailable:true,
    catalogVersion:NEW, switchPending:false, candidateVersion:NEW, candidateBranch:null, candidateTag:selected.release.tag} as unknown as InstalledApp;
  const state = {
    record: JSON.stringify(before), registration: JSON.stringify(installedManifest), projection: productReceipt(old),
    installed, effects: [] as string[],
  };
  const record = () => JSON.parse(state.record) as InstallMetadata;
  const read = (version?: string) => parseFrozenAppManifest(state.registration, app, version, record().manifestDigest);
  let faulted = false, healthChecks = 0;
  function after(name: string) {
    state.effects.push(name);
    if (fault === name && !faulted) { faulted = true; throw Error(`ambiguous ${name}`); }
  }
  const io: ReleaseMetadataIO = {
    metadata: async () => record(),
    save: async m => { state.record = JSON.stringify(m); after('metadata'); },
    installed: async () => structuredClone(installed),
    restoreInstalled: async (_, s) => { Object.assign(installed, s); },
    provenance: async (_, s) => {
      Object.assign(installed, {installedVersion:s.release.version, installedTag:s.release.tag, installedBranch:null, channelSource:s.repository, updateAvailable:false});
      after('provenance');
    },
    manifest: async (_, version) => {
      const manifest = read(version);
      if (version === NEW) after('final-read');
      return manifest;
    },
    syncManifest: async (_, m) => { state.registration = JSON.stringify(m); after('manifest'); },
    verifyProjection: async p => { assert.deepEqual(state.projection, p.receipt); if (p.receipt.manifestSHA256 === selected.manifestSHA256) after('verification'); },
    // Another writer changes the record while the update runs: its change must survive apply and recovery.
    publishProjection: async p => { state.projection = structuredClone(p.receipt); state.record = JSON.stringify({...record(), domain:'current-owner.test'}); after('projection'); },
    // The first check is the quiesce, before anything is written; the second follows the apply.
    health: async () => { if (++healthChecks === 2) after('health'); },
  };
  return {app, source, old, selected, rebuilt, candidate, before, installed, originalInstalled:structuredClone(installed), state, record, read, io};
}
type Box = Awaited<ReturnType<typeof box>>;
function adopt(store: AppUpdateJournalStore, b: Box, selected = b.selected, candidate = b.candidate, before = b.before) {
  return updateIdenticalProductRelease(store, before, b.installed, candidate, selected, nativeManifestReference(selected, candidate), b.io);
}
async function withStore(run: (store: AppUpdateJournalStore) => Promise<void>) {
  const root = mkdtempSync(path.join(tmpdir(), 'ye-product-adoption-'));
  try { await run(new AppUpdateJournalStore(root)); } finally { rmSync(root, {recursive:true, force:true}); }
}
function assertJournal(store: AppUpdateJournalStore, committed: boolean) {
  const journal = store.list()[0];
  assert.equal(journal.operationKind, 'release-metadata');
  assert.equal(journal.phase, 'cleanup', 'the update ended, committed or rolled back and verified; never recovery_required');
  assert.equal(journal.errorCode === 'scoped-restore-unverified', false);
  assert.equal(journal.cleanupComplete, true);
  assert.equal(!!journal.commit, committed);
  assert.equal(!!journal.rollbackVerifiedAt, !committed);
  assert.equal(journal.checkpoints.length, 1);
  assert.equal(journal.checkpoints[0].method, 'scoped-metadata');
  assert.ok(journal.resources.every(r => !r.mutable || r.kind === 'metadata'));
  assert.ok(journal.resources.every(r => !store.isReserved(r)), 'no reservation is held');
}

test('a same-build native release is adopted as a metadata-only update', async t => {
  for (const app of APPS) await t.test(`${app}: adopted`, () => withStore(async store => {
    const b = await box(app);
    const installedCopy = b.read(OLD);
    assert.deepEqual(await adopt(store, b), {success:true, previousVersion:OLD, newVersion:NEW, migrationsRun:0});
    assertJournal(store, true);
    const record = b.record(), artifact = record.nativeArtifacts![0];
    assert.deepEqual(b.state.projection, productReceipt(b.selected));
    assert.equal(record.installedVersion, NEW);
    assert.equal(record.manifestBranch, b.selected.release.tag);
    assert.equal(artifact.version, NEW);
    assert.equal(artifact.releaseTag, b.selected.release.tag);
    assert.deepEqual(artifact.productRelease, productReceipt(b.selected));
    // The updater's "already up to date" check reads this: the adopted release must not be adopted again.
    assert.equal(artifact.productReleaseSHA256, b.selected.manifestSHA256);
    assert.equal(record.domain, 'current-owner.test', 'current owner configuration survives the apply');
    // The record and the registration agree: the installed copy reads as the new release (with or without a version
    // asked), and the record's digest is unchanged and is the copy's.
    const copy = b.read(NEW);
    assert.equal(record.manifestDigest, b.before.manifestDigest);
    assert.equal(copy.frozen?.digest, record.manifestDigest);
    assert.equal(copy.version, NEW);
    assert.equal(copy.frozen?.version, NEW);
    assert.deepEqual(b.read(), copy);
    assert.throws(() => b.read(OLD), /disagree/);
    // Nothing but the release name changed in the installed copy.
    assert.deepEqual({...copy, version:OLD, frozen:{...copy.frozen, version:OLD}}, installedCopy);
    assert.equal(b.installed.installedVersion, NEW);
    assert.equal(b.installed.installedTag, b.selected.release.tag);
    // The floor names the accepted document of the same build; the old name of that build stays acceptable.
    assert.equal(record.productReleaseFloors?.[app].manifestSHA256, b.selected.manifestSHA256);
    assert.doesNotThrow(() => acceptProductSequence(record.productReleaseFloors, b.old));
  }));

  // Notes has screenshots, Search has none.
  for (const app of ['notes', 'search']) for (const fault of FAULTS) await t.test(`${app}: a fault after ${fault} rolls back and verifies`, () => withStore(async store => {
    const b = await box(app, fault);
    const installedCopy = b.read(OLD);
    await assert.rejects(adopt(store, b), new RegExp(`ambiguous ${fault}`));
    assert.ok(b.state.effects.includes(fault));
    assertJournal(store, false);
    const record = b.record();
    assert.deepEqual(b.state.projection, productReceipt(b.old));
    assert.deepEqual({...record, domain:b.before.domain, productReleaseFloors:b.before.productReleaseFloors}, b.before);
    assert.equal(record.domain, 'current-owner.test', 'current owner configuration survives recovery');
    assert.deepEqual(b.installed, b.originalInstalled);
    assert.deepEqual(b.read(OLD), installedCopy);
    assert.deepEqual(b.read(), installedCopy);
    // A retry (the updater reads the record again) is not blocked, and adopts.
    assert.deepEqual(await adopt(store, b, b.selected, b.candidate, record), {success:true, previousVersion:OLD, newVersion:NEW, migrationsRun:0});
    assert.equal(b.read().version, NEW);
  }));

  for (const app of ['notes', 'search']) await t.test(`${app}: another build is never adopted`, () => withStore(async store => {
    const b = await box(app);
    const recordText = b.state.record, registrationText = b.state.registration;
    const unchanged = () => {
      assert.equal(store.list().length, 0);
      assert.equal(b.state.record, recordText);
      assert.equal(b.state.registration, registrationText);
      assert.deepEqual(b.state.projection, productReceipt(b.old));
      assert.deepEqual(b.state.effects, []);
    };
    // The same contract built again: other payload bytes.
    assert.equal(await adopt(store, b, b.rebuilt), null);
    unchanged();
    // A manifest that differs in a contract field is not adopted either, whatever the release says.
    const main = b.candidate.containers.find(c => c.primary)!;
    for (const changed of [
      {...b.candidate, containers:b.candidate.containers.map(c => c === main ? {...c, port:(c.port ?? 0) + 1} : c)},
      {...b.candidate, env_mapping:{...b.candidate.env_mapping, EXTRA:'1'}},
      {...b.candidate, metadata:{...b.candidate.metadata, name:'Another name'}},
      {...b.candidate, frozen:{...b.candidate.frozen!, manifest:`${b.candidate.frozen!.manifest}\n`}},
      {...b.candidate, frozen:{...b.candidate.frozen!, digest:`sha256:${'0'.repeat(64)}`}},
    ]) {
      assert.equal(await adopt(store, b, b.selected, changed), null);
      unchanged();
    }
  }));

  for (const app of ['notes', 'search']) await t.test(`${app}: a stopped app is left to the ordinary update`, () => withStore(async store => {
    const b = await box(app);
    const recordText = b.state.record, registrationText = b.state.registration;
    b.io.running = async () => false;
    assert.equal(await adopt(store, b), null);
    assert.equal(store.list().length, 0);
    assert.equal(b.state.record, recordText);
    assert.equal(b.state.registration, registrationText);
    assert.deepEqual(b.state.effects, []);
    b.io.running = async () => true;
    assert.ok(await adopt(store, b), 'a running app is adopted');
  }));

  await t.test('interruption before recovery initialization has no payload effects', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ye-product-admission-'));
    try {
      const store = new AppUpdateJournalStore(root);
      const lease = store.create({appId:'notes',operationKind:'release-metadata',resources:[{kind:'app',scope:'market',name:'notes',ownerAppId:'notes',mutable:false},{kind:'metadata',scope:'market',name:'notes',ownerAppId:'notes',mutable:true}],originalRunning:{},metadataBeforeSHA256:'a'.repeat(64),source:{manifestSHA256:'b'.repeat(64),artifactSHA256:[]},target:{manifestSHA256:'c'.repeat(64),artifactSHA256:[]}});
      lease.intent('initialize-recovery-plan');
      const id = lease.snapshot().id; lease.release();
      await store.withExecutor(id, async recovered => new AppUpdateTransaction(recovered, new ReleaseMetadataUpdateProvider(root)).recover());
      assert.equal(store.read(id).cleanupComplete, true);
    } finally { rmSync(root, {recursive:true, force:true}); }
  });
});
