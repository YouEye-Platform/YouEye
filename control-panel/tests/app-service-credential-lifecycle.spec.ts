import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  checkAppCredentialTransition, type AppCredentialProjection,
} from '../../shared/app-service-credential';
import { AppServiceCredentialStore } from '../src/lib/apps/service-credential-store';
import {
  prepareCredentialForAppInstall, runAppCredentialLifecycle, type AppCredentialLifecycleEffects,
} from '../src/lib/apps/service-credential-lifecycle';

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'credential-lifecycle-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new AppServiceCredentialStore(directory);
  let verifier: AppCredentialProjection | null = null;
  let runtime = '';
  let running = false;
  let ready = false;
  let failure = '';
  let insideMaintenance = false;
  const observed: string[] = [];
  function boundary(name: string) {
    assert.ok(insideMaintenance);
    observed.push(name);
    if (failure === name) { failure = ''; throw new Error('fixture-private-secret-detail'); }
  }
  const effects: AppCredentialLifecycleEffects = {
    async withMaintenance(action) {
      if (insideMaintenance) throw new Error('Maintenance conflict');
      insideMaintenance = true;
      try { return await action(); } finally { insideMaintenance = false; }
    },
    async markPending() { ready = false; boundary('pending'); },
    async quiesce() { running = false; boundary('quiesced'); },
    async writeRuntime(secret) { runtime = secret; boundary('runtime-written'); },
    async publish(credential, expectedRevision) {
      // A store failure occurs before committing; an ACK failure occurs after.
      boundary(`before-${credential.status}-publication`);
      const result = checkAppCredentialTransition(verifier, credential, expectedRevision);
      if (result === 'apply') verifier = credential;
      boundary(`after-${credential.status}-publication`);
    },
    async restart() { running = true; boundary('restarted'); },
    async probe(credential) {
      assert.ok(running && verifier?.status === 'active');
      assert.equal(verifier?.installationId, credential.installationId);
      assert.equal(verifier?.generation, credential.generation);
      assert.ok(await store.authenticate('wiki', runtime));
      boundary('probed');
    },
    async markReady() { boundary('before-ready'); ready = true; },
    async markRevoked() { ready = false; boundary('revoked'); },
  };
  return {
    directory, store, effects, observed,
    fail: (step: string) => { failure = step; },
    state: () => ({ verifier, ready, running }),
  };
}

test('provision orders protected runtime, verifier activation and real probe before readiness', async t => {
  const f = await fixture(t);
  const result = await runAppCredentialLifecycle('wiki', { action: 'provision' }, f.store, f.effects);
  assert.equal(result.status, 'active');
  assert.equal(result.revision, 2);
  assert.ok(f.state().ready);
  assert.deepEqual(f.observed, [
    'pending', 'quiesced', 'runtime-written',
    'before-prepared-publication', 'after-prepared-publication',
    'before-active-publication', 'after-active-publication',
    'restarted', 'probed', 'before-ready',
  ]);
  const secret = await f.store.runtimeSecret('wiki');
  const replay = await runAppCredentialLifecycle('wiki', { action: 'reconcile' }, f.store, f.effects);
  assert.equal(replay.generation, result.generation);
  assert.equal(replay.revision, result.revision);
  assert.ok(secret === await f.store.runtimeSecret('wiki'));
});

for (const step of [
  'pending', 'quiesced', 'runtime-written',
  'before-prepared-publication', 'after-prepared-publication',
  'before-active-publication', 'after-active-publication',
  'restarted', 'probed', 'before-ready',
]) {
  test(`provision interruption at ${step} retains one generation and never declares readiness`, async t => {
    const f = await fixture(t);
    f.fail(step);
    await assert.rejects(
      runAppCredentialLifecycle('wiki', { action: 'provision' }, f.store, f.effects),
      error => error instanceof Error && error.message === 'App service integration requires reconciliation',
    );
    assert.equal(f.state().ready, false);
    assert.equal(f.state().running, false);
    const secretBefore = await f.store.projection('wiki')
      ? await f.store.runtimeSecret('wiki') : null;
    const restarted = new AppServiceCredentialStore(f.directory);
    const recovered = await runAppCredentialLifecycle('wiki', { action: 'provision' }, restarted, f.effects);
    assert.equal(recovered.generation, 1);
    assert.equal(recovered.revision, 2);
    assert.ok(f.state().ready);
    if (secretBefore) assert.ok(secretBefore === await restarted.runtimeSecret('wiki'));
  });
}

for (const step of [
  'runtime-written', 'before-prepared-publication', 'after-prepared-publication',
  'before-active-publication', 'after-active-publication', 'restarted', 'probed',
]) {
  test(`rotation interruption at ${step} rolls forward without resurrecting old material`, async t => {
    const f = await fixture(t);
    const initial = await runAppCredentialLifecycle('wiki', { action: 'provision' }, f.store, f.effects);
    const old = await f.store.runtimeSecret('wiki');
    f.fail(step);
    await assert.rejects(runAppCredentialLifecycle('wiki', {
      action: 'rotate', expectedRevision: initial.revision,
    }, f.store, f.effects), /requires reconciliation/);
    assert.equal(f.state().ready, false);
    assert.equal(f.state().running, false);
    const preparedSecret = await f.store.runtimeSecret('wiki');
    assert.ok(old !== preparedSecret);
    const recovered = await runAppCredentialLifecycle('wiki', {
      action: 'rotate', expectedRevision: initial.revision,
    }, new AppServiceCredentialStore(f.directory), f.effects);
    assert.equal(recovered.generation, 2);
    assert.equal(recovered.revision, 4);
    assert.ok(preparedSecret === await f.store.runtimeSecret('wiki'));
    assert.ok(await f.store.authenticate('wiki', old) === null);
    assert.ok(f.state().ready);
    const repeated = await runAppCredentialLifecycle('wiki', {
      action: 'rotate', expectedRevision: initial.revision,
    }, f.store, f.effects);
    assert.equal(repeated.revision, recovered.revision);
  });
}

test('failed revocation publication retains revoked local state and retries the same revision', async t => {
  const f = await fixture(t);
  const initial = await runAppCredentialLifecycle('wiki', { action: 'provision' }, f.store, f.effects);
  const old = await f.store.runtimeSecret('wiki');
  f.fail('before-revoked-publication');
  await assert.rejects(runAppCredentialLifecycle('wiki', {
    action: 'revoke', expectedRevision: initial.revision,
  }, f.store, f.effects), /requires reconciliation/);
  assert.equal(f.state().running, false);
  assert.equal(f.state().ready, false);
  assert.ok(await f.store.authenticate('wiki', old) === null);
  const revoked = await runAppCredentialLifecycle('wiki', {
    action: 'revoke', expectedRevision: initial.revision,
  }, f.store, f.effects);
  assert.equal(revoked.status, 'revoked');
  assert.equal(revoked.revision, 3);
  assert.equal(f.state().verifier?.status, 'revoked');
  await assert.rejects(runAppCredentialLifecycle('wiki', { action: 'reconcile' }, f.store, f.effects), /requires reconciliation/);
});

test('ownership-approved reinstall preserves revision tombstone but replaces installation identity', async t => {
  const f = await fixture(t);
  const initial = await runAppCredentialLifecycle('wiki', { action: 'provision' }, f.store, f.effects);
  const old = await f.store.runtimeSecret('wiki');
  const revoked = await runAppCredentialLifecycle('wiki', {
    action: 'revoke', expectedRevision: initial.revision,
  }, f.store, f.effects);
  const replacement = await runAppCredentialLifecycle('wiki', {
    action: 'reinstall', expectedRevision: revoked.revision,
  }, f.store, f.effects);
  assert.notEqual(replacement.installationId, initial.installationId);
  assert.equal(replacement.generation, 1);
  assert.equal(replacement.revision, 5);
  assert.ok(await f.store.authenticate('wiki', old) === null);
});

test('maintenance adapter failures are sanitized before leaving the lifecycle boundary', async t => {
  const f = await fixture(t);
  f.effects.withMaintenance = async () => { throw new Error('fixture-private-maintenance-detail'); };
  await assert.rejects(runAppCredentialLifecycle('wiki', {
    action: 'provision',
  }, f.store, f.effects), error => error instanceof Error
    && error.message === 'App service integration requires reconciliation');
  assert.equal(f.state().ready, false);
  assert.equal(await f.store.projection('wiki'), null);
});

test('deliberate install after keep-data revocation adopts a fresh identity and retries the same generation', async t => {
  const f = await fixture(t);
  const initial = await runAppCredentialLifecycle('wiki', { action: 'provision' }, f.store, f.effects);
  const old = await f.store.runtimeSecret('wiki');
  const revoked = await runAppCredentialLifecycle('wiki', {
    action: 'revoke', expectedRevision: initial.revision,
  }, f.store, f.effects);
  // Ordinary rendering/provision and reconciliation still cannot undo uninstall.
  await assert.rejects(f.store.provisionForInstall('wiki'), /explicit adoption/);
  await assert.rejects(runAppCredentialLifecycle('wiki', { action: 'reconcile' }, f.store, f.effects));
  const adopted = await prepareCredentialForAppInstall('wiki', f.store);
  const next = await f.store.runtimeSecret('wiki');
  assert.notEqual(adopted.installationId, initial.installationId);
  assert.equal(adopted.revision, revoked.revision + 1);
  assert.equal(adopted.generation, 1);
  assert.ok(next !== old);
  assert.equal(await f.store.authenticate('wiki', old), null);
  assert.equal(await f.store.authenticate('wiki', next), null);
  const recreated = new AppServiceCredentialStore(f.directory);
  assert.deepEqual(await prepareCredentialForAppInstall('wiki', recreated), adopted);
  assert.ok(await recreated.runtimeSecret('wiki') === next);
  f.fail('after-active-publication');
  await assert.rejects(runAppCredentialLifecycle('wiki', { action: 'reconcile' }, recreated, f.effects));
  const retry = await prepareCredentialForAppInstall('wiki', recreated);
  assert.equal(retry.installationId, adopted.installationId);
  assert.equal(retry.revision, adopted.revision + 1);
  const ready = await runAppCredentialLifecycle('wiki', { action: 'reconcile' }, recreated, f.effects);
  assert.equal(ready.revision, retry.revision);
  assert.equal(await f.store.authenticate('wiki', old), null);
  assert.ok(await f.store.authenticate('wiki', next));
  assert.ok(f.state().ready);
});

test('installer adoption cannot guess missing or corrupt authority', async t => {
  const f = await fixture(t);
  const initial = await prepareCredentialForAppInstall('wiki', f.store);
  assert.equal(initial.status, 'prepared');
  await rm(path.join(f.directory, 'wiki', 'credential.json'));
  await assert.rejects(prepareCredentialForAppInstall('wiki', f.store), /requires repair/);
  assert.equal(await f.store.authenticate('wiki', 'not-a-credential'), null);
});
