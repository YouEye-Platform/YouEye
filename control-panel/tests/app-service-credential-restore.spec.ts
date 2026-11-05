import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AppServiceCredentialStore } from '../src/lib/apps/service-credential-store';
import { checkAppCredentialRestoreFence, checkAppCredentialTransition } from '../../shared/app-service-credential';
import { reconcileRetainedCredential } from '../src/lib/apps/service-credential-retained-restore';
import { checkAppCredentialBatch } from '../../shared/app-service-credential';

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'credential-restore-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, store: new AppServiceCredentialStore(directory) };
}

test('cross-target restore retires source material and prepares a different installation without copying its secret', async t => {
  const source = await fixture(t);
  const target = await fixture(t);
  await source.store.provisionForInstall('wiki');
  const old = await source.store.runtimeSecret('wiki');
  const currentUI = await source.store.activate('wiki', 1);
  const fence = await target.store.fenceForRestore('wiki', currentUI);
  assert.equal(checkAppCredentialRestoreFence(currentUI, fence, currentUI), 'apply');
  assert.equal(fence.status, 'revoked');
  await assert.rejects(() => target.store.runtimeSecret('wiki'));
  assert.equal(await target.store.authenticate('wiki', old), null);
  await target.store.acknowledgePublication('wiki', fence.revision);
  const prepared = await target.store.prepareReinstall('wiki', fence.revision);
  assert.equal(checkAppCredentialTransition(fence, prepared, fence.revision), 'apply');
  const active = await target.store.activate('wiki', prepared.revision);
  assert.notEqual(active.installationId, currentUI.installationId);
  assert.ok(old !== await target.store.runtimeSecret('wiki'));
  assert.equal(await target.store.authenticate('wiki', old), null);
  assert.ok(await source.store.authenticate('wiki', old)); // Source remains independently active.
});

test('same-target old UI restore cannot rewind retained revocation or resurrect its generation', async t => {
  const f = await fixture(t);
  await f.store.provisionForInstall('wiki');
  const old = await f.store.runtimeSecret('wiki');
  const backedUI = await f.store.activate('wiki', 1);
  await f.store.prepareRotation('wiki', 2);
  await f.store.activate('wiki', 3);
  const revoked = await f.store.revoke('wiki', 4);
  const fence = await f.store.fenceForRestore('wiki', backedUI);
  assert.equal(fence.revision, revoked.revision);
  assert.equal(fence.generation, revoked.generation);
  assert.equal(checkAppCredentialRestoreFence(backedUI, fence, backedUI), 'apply');
  assert.equal(await f.store.authenticate('wiki', old), null);
  assert.throws(() => checkAppCredentialTransition(fence, backedUI, fence.revision));
  // A lost ACK/restart reuses exactly the durable fence.
  const restarted = new AppServiceCredentialStore(f.directory);
  assert.deepEqual(await restarted.fenceForRestore('wiki', backedUI), fence);
  assert.deepEqual(await restarted.fenceForRestore('wiki', fence), fence);
  assert.equal(checkAppCredentialRestoreFence(fence, fence, backedUI), 'unchanged');
});

test('restore CAS rejects activation, wrong identity, stale read and revision rewind', async t => {
  const f = await fixture(t);
  const source = await f.store.provisionForInstall('wiki');
  const active = await f.store.activate('wiki', 1);
  const fence = await f.store.fenceForRestore('wiki', active);
  assert.throws(() => checkAppCredentialRestoreFence(active, { ...active, revision: fence.revision }, active));
  assert.throws(() => checkAppCredentialRestoreFence(active, fence, source));
  assert.throws(() => checkAppCredentialRestoreFence(active, { ...fence, appId: 'notes' }, active));
  assert.throws(() => checkAppCredentialRestoreFence(active, { ...fence, revision: active.revision }, active));
  assert.throws(() => checkAppCredentialRestoreFence(fence, { ...source, revision: fence.revision + 1 }, fence));
  assert.throws(() => checkAppCredentialRestoreFence(active, fence, null));
  assert.throws(() => checkAppCredentialRestoreFence(null, fence, active));
});

test('fresh verifier/store restore can establish only a tombstone before fresh installation', async t => {
  const f = await fixture(t);
  const fence = await f.store.fenceForRestore('wiki', null);
  assert.equal(checkAppCredentialRestoreFence(null, fence, null), 'apply');
  assert.equal(fence.revision, 1);
  assert.equal(fence.status, 'revoked');
  assert.deepEqual(await f.store.pendingPublications('wiki'), [fence]);
  await assert.rejects(() => f.store.runtimeSecret('wiki'));
  await assert.rejects(() => f.store.provisionForInstall('wiki'));
});

async function retainedFixture(t: test.TestContext) {
  const f = await fixture(t);
  await f.store.provisionForInstall('wiki');
  const archived = await f.store.activate('wiki', 1);
  await f.store.acknowledgePublication('wiki', archived.revision);
  let verifier = archived;
  const effects = {
    async readVerifier() { return verifier; },
    async publish(credential: typeof archived) {
      const pending = await f.store.pendingPublications('wiki');
      const incoming = pending.length ? pending : [credential];
      verifier = checkAppCredentialBatch(verifier, incoming, incoming[0].revision - 1).credential;
      await f.store.acknowledgePublication('wiki', credential.revision);
    },
    async publishFence(credential: typeof archived, expected: typeof archived | null) {
      checkAppCredentialRestoreFence(verifier, credential, expected);
      verifier = credential;
    },
  };
  return { ...f, archived, effects, getVerifier: () => verifier, resetVerifier: () => { verifier = archived; } };
}

test('core-only equal verifier preserves the retained installation, generation and secret', async t => {
  const f = await retainedFixture(t);
  const secret = await f.store.runtimeSecret('wiki');
  assert.equal(await reconcileRetainedCredential('wiki', f.store, f.effects), 'pending');
  assert.deepEqual(await f.store.projection('wiki'), f.archived);
  assert.ok(secret === await f.store.runtimeSecret('wiki'));
});

test('core-only historical verifier rotates a retained installation through denial, idempotently', async t => {
  const f = await retainedFixture(t);
  await f.store.prepareRotation('wiki', 2);
  const current = await f.store.activate('wiki', 3);
  await f.store.acknowledgePublication('wiki', current.revision);
  const secret = await f.store.runtimeSecret('wiki');
  assert.equal(await reconcileRetainedCredential('wiki', f.store, f.effects), 'pending');
  const prepared = await f.store.projection('wiki');
  assert.equal(prepared?.installationId, current.installationId);
  assert.equal(prepared?.generation, current.generation + 1);
  assert.equal(prepared?.status, 'prepared');
  assert.equal(await f.store.authenticate('wiki', secret), null);
  assert.equal(f.getVerifier().status, 'prepared');
  const freshSecret = await f.store.runtimeSecret('wiki');
  await reconcileRetainedCredential('wiki', new AppServiceCredentialStore(f.directory), f.effects);
  assert.deepEqual(await f.store.projection('wiki'), prepared);
  assert.ok(freshSecret === await f.store.runtimeSecret('wiki'));
});

test('core-only restore never automatically reopens explicitly revoked retained credentials', async t => {
  const f = await retainedFixture(t);
  const secret = await f.store.runtimeSecret('wiki');
  const revoked = await f.store.revoke('wiki', 2);
  await f.store.acknowledgePublication('wiki', revoked.revision);
  assert.equal(await reconcileRetainedCredential('wiki', f.store, f.effects), 'revoked');
  assert.equal(f.getVerifier().status, 'revoked');
  assert.equal(await f.store.authenticate('wiki', secret), null);
  await assert.rejects(() => f.store.runtimeSecret('wiki'));
});

test('core-only interruption at fence publication resumes the durable restore marker once', async t => {
  const f = await retainedFixture(t);
  await f.store.prepareRotation('wiki', 2);
  const current = await f.store.activate('wiki', 3);
  await f.store.acknowledgePublication('wiki', 4);
  await assert.rejects(() => reconcileRetainedCredential('wiki', f.store, {
    ...f.effects, async publishFence() { throw new Error('bridge offline'); },
  }));
  const fence = await f.store.projection('wiki');
  assert.equal(fence?.status, 'revoked');
  assert.equal((await f.store.status('wiki'))?.operationKind, 'restore');
  assert.equal(await reconcileRetainedCredential('wiki', new AppServiceCredentialStore(f.directory), f.effects), 'pending');
  assert.equal((await f.store.projection('wiki'))?.generation, current.generation + 1);
});

test('equal-state bridge failure retains the existing secret and does not mint a rotation', async t => {
  const f = await retainedFixture(t);
  const secret = await f.store.runtimeSecret('wiki');
  await assert.rejects(() => reconcileRetainedCredential('wiki', f.store, {
    ...f.effects, async publish() { throw new Error('bridge offline'); },
  }));
  assert.deepEqual(await f.store.projection('wiki'), f.archived);
  assert.ok(secret === await f.store.runtimeSecret('wiki'));
});

test('core-only restore rejects a missing authority instead of importing archived authority', async t => {
  const f = await retainedFixture(t);
  const missing = await fixture(t);
  await assert.rejects(() => reconcileRetainedCredential('wiki', missing.store, f.effects));
  assert.equal(await missing.store.projection('wiki'), null);
});

test('same-target replacement acknowledges the exact already-published revoked fence after a fresh read', async t => {
  const f = await fixture(t);
  await f.store.provisionForInstall('wiki');
  const active = await f.store.activate('wiki', 1);
  const old = await f.store.runtimeSecret('wiki');
  const revoked = await f.store.revoke('wiki', active.revision);
  await f.store.acknowledgePublication('wiki', revoked.revision);
  const fence = await f.store.fenceForRestore('wiki', revoked);
  assert.deepEqual(fence, revoked);
  assert.equal(checkAppCredentialRestoreFence(revoked, fence, revoked), 'unchanged');
  await f.store.acknowledgePublication('wiki', fence.revision);
  const prepared = await f.store.prepareReinstall('wiki', fence.revision);
  assert.notEqual(prepared.installationId, revoked.installationId);
  assert.equal(prepared.revision, revoked.revision + 1);
  assert.equal(await f.store.authenticate('wiki', old), null);
});
