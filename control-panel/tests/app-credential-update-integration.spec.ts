import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AppServiceCredentialStore } from '../src/lib/apps/service-credential-store';
import { AppUpdateJournalStore, type NewAppUpdate } from '../src/lib/market/update-journal';
import { withAppLifecycle, AppLifecycleAdmissionError } from '../src/lib/market/update-admission';

const hash = 'a'.repeat(64);
const input: NewAppUpdate = {
  appId: 'fixture', source: { manifestSHA256: hash, artifactSHA256: [] },
  target: { manifestSHA256: hash, artifactSHA256: [] },
  resources: [{kind: 'app', scope: 'market', name: 'fixture', ownerAppId: 'fixture', mutable: false}],
  originalRunning: {}, metadataBeforeSHA256: hash,
};

test('real credential authority contends with updater and retains revocation through cleanup', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'credential-update-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const journal = new AppUpdateJournalStore(path.join(root, 'journal'));
  const lifecycle: typeof withAppLifecycle = (appId, work) => withAppLifecycle(appId, work, {store: journal});
  const store = new AppServiceCredentialStore(path.join(root, 'credentials'), undefined, lifecycle);
  const prepared = await store.provisionForInstall('fixture');
  const active = await store.activate('fixture', prepared.revision);
  const secret = await store.runtimeSecret('fixture');
  const revoked = await store.revoke('fixture', active.revision);
  let id = '';
  await lifecycle('fixture', async () => {
    const lease = journal.create(input); id = lease.snapshot().id;
    try { lease.recoveryRequired('interrupted'); } finally { lease.release(); }
    // Recovery holds the same lifecycle gate, while credential state stays current.
    assert.equal((await store.projection('fixture'))?.revision, revoked.revision);
  });
  await assert.rejects(store.prepareRotation('fixture', revoked.revision), AppLifecycleAdmissionError);
  await assert.rejects(store.provisionForInstall('fixture'), AppLifecycleAdmissionError);
  assert.equal(await store.authenticate('fixture', secret), null);
  await withAppLifecycle('fixture', async () => {
    await journal.withExecutor(id, async lease => {
      lease.transition('recovering'); lease.rolledBack(); lease.transition('cleanup'); lease.finishCleanup();
      assert.equal((await store.projection('fixture'))?.status, 'revoked');
    });
  }, {store: journal, recoveryOperationId: id});
  assert.equal((await store.projection('fixture'))?.revision, revoked.revision);
  assert.equal(await store.authenticate('fixture', secret), null);
  await assert.rejects(store.provisionForInstall('fixture'), /explicit adoption/);
});
