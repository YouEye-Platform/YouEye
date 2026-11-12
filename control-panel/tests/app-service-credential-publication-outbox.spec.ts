import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AppServiceCredentialStore } from '../src/lib/apps/service-credential-store';
import { checkAppCredentialBatch } from '../../shared/app-service-credential';
import { rewriteCredentialEnvironment, assertPrivateCredentialMapping, assertPrivateCredentialConfig } from '../src/lib/apps/service-credential-runtime';

test('revocation outbox survives restart and atomically publishes only the final denied state', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'credential-outbox-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let store = new AppServiceCredentialStore(root);
  await store.provisionForInstall('wiki');
  await store.activate('wiki', 1);
  await store.revoke('wiki', 2);
  store = new AppServiceCredentialStore(root);
  const pending = await store.pendingPublications('wiki');
  assert.deepEqual(pending.map(item => item.revision), [1, 2, 3]);
  assert.deepEqual(pending.map(item => item.status), ['prepared', 'active', 'revoked']);
  const applied = checkAppCredentialBatch(null, pending, 0);
  assert.equal(applied.credential.status, 'revoked');
  assert.equal(applied.credential.revision, 3);
  // A lost acknowledgement retries the same batch without a state mutation.
  assert.equal(checkAppCredentialBatch(applied.credential, pending, 0).result, 'unchanged');
  await store.acknowledgePublication('wiki', 3);
  assert.deepEqual(await new AppServiceCredentialStore(root).pendingPublications('wiki'), []);
  await assert.rejects(() => store.runtimeSecret('wiki'));
  await assert.rejects(() => store.acknowledgePublication('wiki', 2));
  await assert.rejects(() => store.acknowledgePublication('wiki', 4));
  assert.throws(() => checkAppCredentialBatch(applied.credential, [pending[1]], 1));
});

test('credential templates reject public paths and world-readable files before runtime injection', () => {
  const file = {
    path: '/etc/app/service.conf', template: '${integration.app_token}',
    permission: '0o600', directoryPermission: '0o700',
  };
  assert.doesNotThrow(() => assertPrivateCredentialConfig([file]));
  for (const changed of [
    { path: '/opt/app/public/runtime.json' }, { path: '/etc/../opt/app/public/token' },
    { permission: '0o644' }, { directoryPermission: '0o755' }, { path: '/etc/a\0b' },
  ]) assert.throws(() => assertPrivateCredentialConfig([{ ...file, ...changed }]));
  assert.doesNotThrow(() => assertPrivateCredentialConfig([{
    ...file, path: '/opt/app/public/branding.json', template: '${platform.siteName}', permission: '0o644',
  }]));
});

test('current generation acknowledgement cannot erase later pending rotation', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'credential-outbox-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new AppServiceCredentialStore(root);
  await store.provisionForInstall('wiki');
  await store.activate('wiki', 1);
  await store.acknowledgePublication('wiki', 2);
  await store.prepareRotation('wiki', 2);
  await store.acknowledgePublication('wiki', 2);
  const pending = await store.pendingPublications('wiki');
  assert.deepEqual(pending.map(item => item.revision), [3]);
  assert.throws(() => checkAppCredentialBatch(null, pending, 2));
});

test('runtime reinjection preserves unrelated settings and refuses ambiguous/public/unsafe injection', () => {
  const value = rewriteCredentialEnvironment('DATABASE_URL=retained\nYOUEYE_APP_TOKEN=old\n# comment\n', {
    YOUEYE_APP_TOKEN: 'new', YOUEYE_APP_ID: 'wiki',
  });
  assert.ok(value.includes('DATABASE_URL=retained\n'));
  assert.ok(value.includes('YOUEYE_APP_TOKEN=new\n'));
  assert.ok(value.includes('YOUEYE_APP_ID=wiki\n'));
  assert.ok(!value.includes('=old'));
  assert.throws(() => rewriteCredentialEnvironment('TOKEN=a\nTOKEN=b\n', { TOKEN: 'c' }));
  assert.throws(() => rewriteCredentialEnvironment('', { NEXT_PUBLIC_TOKEN: 'fixture' }));
  assert.throws(() => rewriteCredentialEnvironment('', { TOKEN: 'line\nbreak' }));
  assert.throws(() => assertPrivateCredentialMapping({ NEXT_PUBLIC_AUTH: 'prefix-fixture' }, 'fixture'));
  assert.doesNotThrow(() => assertPrivateCredentialMapping({ NEXT_PUBLIC_APP_ID: 'wiki', TOKEN: 'fixture' }, 'fixture'));
});
