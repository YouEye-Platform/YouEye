import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createMissingSecret, credentialRecords, generatedSecretNames, generatedSecretStep, InstalledSecretMissingError,
  lostInstalledSecrets, missingSecrets, removeGeneratedSecrets, secretGenerator,
} from '../src/lib/market/manifest-secrets';
import { appSecretStoreAt } from '../src/lib/infrastructure/secrets';
import type { SecretSpec } from '../src/lib/market/types';

// YE-208: an update adds the secrets its release newly declares and shows the release's credentials.

const secret = (name: string, generator: SecretSpec['generator'] = 'password', length = 24): SecretSpec =>
  ({ name, file: `secrets/${name}`, generator, length });

function store(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  const writes: string[] = [];
  return {
    files, writes,
    read: async (appId: string, name: string) => files.get(`${appId}/${name}`) ?? null,
    write: async (appId: string, name: string, value: string) => { writes.push(`${appId}/${name}`); files.set(`${appId}/${name}`, value); },
  };
}

test('only the declared secrets the installation lacks are missing; existing and unreadable ones never are', () => {
  const manifest = { secrets: [secret('api_key', 'hexToken', 16), secret('admin_password'), secret('broken')] };
  const installed = { secrets: [] as SecretSpec[] };
  // api_key exists (read), admin_password is new in this release, broken could not be read safely.
  assert.deepEqual(missingSecrets(manifest, installed, { api_key: 'abc' }, new Set(['broken'])).map((s) => s.name), ['admin_password']);
  // A release without secrets (or with all of them present) generates nothing.
  assert.deepEqual(missingSecrets({ secrets: [] }, installed, {}, new Set()), []);
  assert.deepEqual(missingSecrets(manifest, installed, { api_key: 'a', admin_password: 'b', broken: 'c' }, new Set()), []);
});

test('a missing secret is generated per its spec and written once; an existing one is never replaced', async () => {
  const s = store({ 'navidrome/api_key': 'kept' });
  const value = await createMissingSecret('navidrome', secret('admin_password', 'password', 24), s);
  assert.equal(value.length, 24);
  assert.match(value, /^[A-Za-z0-9_-]+$/);
  assert.equal(s.files.get('navidrome/admin_password'), value);
  await assert.rejects(createMissingSecret('navidrome', secret('api_key'), s), /exists already/);
  assert.equal(s.files.get('navidrome/api_key'), 'kept');
  assert.deepEqual(s.writes, ['navidrome/admin_password']);
  // The generators are install's: hex tokens are bytes as hex, secret keys base64, unknown kinds a password.
  assert.match(secretGenerator('hexToken', 16)(), /^[a-f0-9]{32}$/);
  assert.equal(Buffer.from(secretGenerator('secretKey', 32)(), 'base64').length, 32);
  assert.equal(secretGenerator('other', 10)().length, 10);
});

test('the journal names the generated secrets; the rollback deletes exactly those, intended or completed', async () => {
  const record = {
    appId: 'changedetection',
    steps: [
      { id: 'initialize-recovery-plan' },
      { id: generatedSecretStep('admin_password') },
      { id: 'generate-secret-session_key' },
      { id: 'generate-secret-../../etc' },
      { id: 'apply-generated-configuration' },
    ],
  };
  assert.deepEqual(generatedSecretNames(record), ['admin_password', 'session_key']);
  const removed: string[] = [];
  assert.deepEqual(await removeGeneratedSecrets(record, async (appId, name) => { removed.push(`${appId}/${name}`); }),
    ['admin_password', 'session_key']);
  assert.deepEqual(removed, ['changedetection/admin_password', 'changedetection/session_key']);
  // An update that generated nothing (every update before 0.6.20, too) deletes nothing.
  assert.deepEqual(await removeGeneratedSecrets({ appId: 'x', steps: [{ id: 'apply-generated-configuration' }] },
    async () => { throw new Error('nothing to delete'); }), []);
  assert.throws(() => generatedSecretStep('Bad-Name'), /Invalid app secret name/);
  // A step id stays a journal identifier (letters, digits, _ . -; at most 128).
  assert.match(generatedSecretStep('a'.repeat(40)), /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/);
});

test('the shown credentials follow the manifest: added, changed, removed and unchanged', () => {
  const admin = { label: 'Administrator', username: 'admin', passwordSecret: 'api_key' };
  assert.deepEqual(credentialRecords({ credentials: [admin] }), [admin]);
  assert.deepEqual(credentialRecords({ credentials: [{ ...admin, username: 'owner' }] }), [{ ...admin, username: 'owner' }]);
  assert.equal(credentialRecords({ credentials: [] }), undefined);
  assert.equal(credentialRecords({}), undefined);
  // Only the three recorded fields (the record format is unchanged).
  assert.deepEqual(Object.keys(credentialRecords({ credentials: [{ ...admin, extra: 1 } as typeof admin] })![0]),
    ['label', 'username', 'passwordSecret']);
});

test('the updater generates missing secrets inside the transaction before rendering, and records the credentials', () => {
  const updater = readFileSync(new URL('../src/lib/market/updater.ts', import.meta.url), 'utf8');
  const transaction = updater.indexOf('runAppUpdateTransaction(appUpdateJournalStore()');
  const generate = updater.indexOf('missingSecrets(manifest, preflight.old, ctx.secret');
  const render = updater.indexOf("transaction.mutate('apply-generated-configuration'");
  assert.ok(transaction > 0 && transaction < generate && generate < render, 'generated in the transaction, before rendering');
  assert.match(updater, /transaction\.mutate\(generatedSecretStep\(secret\.name\), \(\) => createMissingSecret\(appId, secret\)\)/);
  // A secret that could not be read is never treated as missing.
  assert.match(updater, /catch \{\s*unreadableSecrets\.add\(secret\.name\);/);
  const credentials = updater.indexOf('installMeta.credentials = credentialRecords(manifest);');
  assert.ok(credentials > 0 && credentials < updater.indexOf("transaction.mutate('publish-install-metadata'"));
  // Install writes the same mapping.
  const engine = readFileSync(new URL('../src/lib/market/engine.ts', import.meta.url), 'utf8');
  assert.equal(engine.match(/credentials: credentialRecords\(manifest\),/g)?.length, 2);
  // The rollback restores the shown credentials and deletes the generated secrets before comparing security state.
  const provider = readFileSync(new URL('../src/lib/market/update-provider.ts', import.meta.url), 'utf8');
  assert.match(provider, /'nativeArtifacts', 'containers', 'credentials'\] as const/);
  assert.ok(provider.indexOf('await removeGeneratedSecrets(record)') < provider.indexOf('await this.securityChanges(record)'));
});

// ── YE-217: never a new value for a secret the installed version declared ──

test('a name new in this release is generated; a name the installed version declared never is (YE-217)', () => {
  const installed = { secrets: [secret('encryption_key', 'secretKey', 32)] };
  const target = { secrets: [secret('encryption_key', 'secretKey', 32), secret('admin_password')] };
  // New name: generated. Old name present: kept, nothing to generate, nothing lost.
  assert.deepEqual(missingSecrets(target, installed, { encryption_key: 'kept' }, new Set()).map((s) => s.name), ['admin_password']);
  assert.deepEqual(lostInstalledSecrets(target, installed, { encryption_key: 'kept' }), []);
  // Old name missing (null read: absent, empty or whitespace): never generated, and the update stops on it.
  assert.deepEqual(missingSecrets(target, installed, {}, new Set()).map((s) => s.name), ['admin_password']);
  assert.deepEqual(lostInstalledSecrets(target, installed, {}), ['encryption_key']);
  // An unreadable old name has no value either, so it stops the update too; a name only the installed version had is no concern.
  assert.deepEqual(lostInstalledSecrets(target, installed, {}), ['encryption_key']);
  assert.deepEqual(lostInstalledSecrets({ secrets: [secret('admin_password')] }, installed, {}), []);
  // An installed manifest without a secrets list declares none.
  assert.deepEqual(lostInstalledSecrets(target, {} as { secrets: SecretSpec[] }, {}), []);
});

test('an empty, whitespace or pre-0.6.3 secret reads as missing and stops the update without its value (YE-217)', async () => {
  const base = mkdtempSync(path.join(tmpdir(), 'ye217-'));
  try {
    const store = appSecretStoreAt(base);
    const installed = { secrets: [secret('n8n_key', 'secretKey', 32), secret('session_secret')] };
    const target = installed;
    // Empty and whitespace-only files in today's place.
    await store.write('n8n', 'n8n_key', '');
    await store.write('n8n', 'session_secret', '  \n\t ');
    // Before 0.6.3 an install kept a secret at app-<id>/<file>; today's store reads app-<id>/secrets/<name>.
    mkdirSync(path.join(base, 'app-old'), { recursive: true });
    writeFileSync(path.join(base, 'app-old', 'n8n_key'), 'the-old-key-value', { mode: 0o600 });
    for (const appId of ['n8n', 'old']) {
      const existing: Record<string, string> = {};
      for (const s of target.secrets) {
        const value = await store.read(appId, s.name);
        if (value) existing[s.name] = value;
      }
      assert.deepEqual(missingSecrets(target, installed, existing, new Set()), [], `${appId}: nothing is generated`);
      const lost = lostInstalledSecrets(target, installed, existing);
      assert.deepEqual(lost, ['n8n_key', 'session_secret'], `${appId}: both stop the update`);
      const error = new InstalledSecretMissingError(appId, lost);
      assert.equal(error.code, 'installed-secret-missing');
      assert.match(error.message, /stopped before changing anything.*n8n_key, session_secret.*none is made/s);
      assert.doesNotMatch(error.message, /the-old-key-value/);
    }
    // The old file stays where it was: nothing writes over it.
    assert.equal((await import('node:fs')).readFileSync(path.join(base, 'app-old', 'n8n_key'), 'utf8'), 'the-old-key-value');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('the updater stops on a lost installed secret right after preflight, before the transaction (YE-217)', () => {
  const updater = readFileSync(new URL('../src/lib/market/updater.ts', import.meta.url), 'utf8');
  const check = updater.indexOf('const lost = lostInstalledSecrets(manifest, preflight.old, ctx.secret ?? {});');
  const transaction = updater.indexOf('runAppUpdateTransaction(appUpdateJournalStore()');
  assert.ok(check > 0 && check < transaction, 'checked before anything is changed');
  assert.match(updater, /if \(lost\.length\) throw new InstalledSecretMissingError\(appId, lost\);/);
  // The failure answer carries the error's code (`installed-secret-missing`) and message, never a value.
  assert.match(updater, /'code' in error && typeof error\.code === 'string' \? error\.code/);
});
