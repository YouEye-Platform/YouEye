import assert from 'node:assert/strict';
import { cp, link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fingerprintSetupRestoreSource, importFreshSetupRestoreSource } from '../src/lib/setup/restore-source';
import { SetupRestoreError } from '../src/lib/setup/restore-recovery';

const backupId = 'backup-20261029T120000Z-1234abcd';
const code = (expected: string) => (error: unknown) => error instanceof SetupRestoreError && error.code === expected;
async function fixture(t: { after: (work: () => Promise<void>) => void }) {
  const root = await mkdtemp(path.join(tmpdir(), 'setup-restore-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = path.join(root, 'drive');
  await mkdir(path.join(input, 'youeye/core'), { recursive: true });
  await mkdir(path.join(input, 'youeye/apps/notes'), { recursive: true });
  await mkdir(path.join(input, 'youeye/apps/cinema'), { recursive: true });
  await writeFile(path.join(input, 'backup-set.json'), JSON.stringify({
    schema: 'youeye.backup.set.v1', id: backupId, status: 'completed', apps: ['notes', 'cinema'],
    source: { schema: 'youeye.backup.source.v1', runtime_kind: 'mutable-host', spine_version: '1' },
  }));
  await writeFile(path.join(input, 'youeye/core/core-fixture.tar.enc'), 'encrypted-core-fixture');
  await writeFile(path.join(input, 'youeye/apps/notes/notes-fixture.tar.enc'), 'encrypted-notes-fixture');
  await writeFile(path.join(input, 'youeye/apps/cinema/cinema-fixture.tar.enc'), 'encrypted-cinema-fixture');
  const cache = path.join(root, `import-${backupId}`);
  return { root, input, cache };
}

test('source binds the metadata, core and selected encrypted app bytes independent of selection order', async t => {
  const f = await fixture(t);
  const digest = await fingerprintSetupRestoreSource(f.input, backupId, ['notes', 'cinema']);
  assert.equal(await fingerprintSetupRestoreSource(f.input, backupId, ['cinema', 'notes']), digest);
  const coreOnly = await fingerprintSetupRestoreSource(f.input, backupId, []);
  await writeFile(path.join(f.input, 'youeye/apps/notes/notes-fixture.tar.enc'), 'different-encrypted-notes');
  assert.notEqual(await fingerprintSetupRestoreSource(f.input, backupId, ['notes', 'cinema']), digest);
  assert.equal(await fingerprintSetupRestoreSource(f.input, backupId, []), coreOnly);
  await writeFile(path.join(f.input, 'youeye/core/core-fixture.tar.enc'), 'different-encrypted-core');
  assert.notEqual(await fingerprintSetupRestoreSource(f.input, backupId, []), coreOnly);
});

test('foreign labels, incomplete metadata, missing selected archives and unsafe files cannot be fingerprints', async t => {
  const f = await fixture(t);
  for (const selection of [['foreign'], ['notes', 'notes'], ['../notes']]) {
    await assert.rejects(fingerprintSetupRestoreSource(f.input, backupId, selection), code('source-mismatch'));
  }
  await assert.rejects(fingerprintSetupRestoreSource(f.input, 'backup-20261029T120001Z-1234abcd', []), code('source-mismatch'));
  const metadata = path.join(f.input, 'backup-set.json');
  const original = await readFile(metadata, 'utf8');
  for (const change of [{ status: 'creating' }, { source: {} }, { apps: ['notes', 'notes'] }]) {
    await writeFile(metadata, JSON.stringify({ ...JSON.parse(original), ...change }));
    await assert.rejects(fingerprintSetupRestoreSource(f.input, backupId, []), code('source-mismatch'));
  }
  await writeFile(metadata, original);
  await rm(path.join(f.input, 'youeye/apps/notes'), { recursive: true });
  await assert.rejects(fingerprintSetupRestoreSource(f.input, backupId, ['notes']), code('source-mismatch'));
  const unsafe = path.join(f.input, 'youeye/core/unsafe');
  await symlink(path.join(f.input, 'youeye/apps/cinema'), unsafe);
  await assert.rejects(fingerprintSetupRestoreSource(f.input, backupId, []), code('source-mismatch'));
  await rm(unsafe);
  await link(path.join(f.input, 'youeye/core/core-fixture.tar.enc'), unsafe);
  await assert.rejects(fingerprintSetupRestoreSource(f.input, backupId, []), code('source-mismatch'));
});

test('a cached original cannot conceal a changed drive source, and the original input is preserved', async t => {
  const f = await fixture(t);
  await cp(f.input, f.cache, { recursive: true });
  const expectedSource = await fingerprintSetupRestoreSource(f.cache, backupId, ['notes']);
  await writeFile(path.join(f.input, 'youeye/apps/notes/notes-fixture.tar.enc'), 'changed-on-external-drive');
  let imports = 0;
  await assert.rejects(importFreshSetupRestoreSource({
    root: f.root, backupId, appIds: ['notes'], expectedSource,
    importBackup: async () => {
      imports++;
      await assert.rejects(readFile(path.join(f.cache, 'backup-set.json')), { code: 'ENOENT' });
      await cp(f.input, f.cache, { recursive: true });
      return f.cache;
    },
  }), code('source-mismatch'));
  assert.equal(imports, 1);
  assert.equal(await fingerprintSetupRestoreSource(f.cache, backupId, ['notes']), expectedSource);
  assert.deepEqual((await readdir(f.root)).sort(), ['drive', `import-${backupId}`].sort());
});

test('every restore attempt authenticates fresh input, and matching input replaces only its old cache', async t => {
  const f = await fixture(t);
  const expectedSource = await fingerprintSetupRestoreSource(f.input, backupId, ['notes']);
  await cp(f.input, f.cache, { recursive: true });
  let imports = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await importFreshSetupRestoreSource({
      root: f.root, backupId, appIds: ['notes'], expectedSource,
      importBackup: async () => {
        imports++;
        await assert.rejects(readFile(path.join(f.cache, 'backup-set.json')), { code: 'ENOENT' });
        await cp(f.input, f.cache, { recursive: true });
        return f.cache;
      },
    });
    assert.deepEqual(result, { backupPath: f.cache, source: expectedSource });
    assert.deepEqual((await readdir(f.root)).sort(), ['drive', `import-${backupId}`].sort());
  }
  assert.equal(imports, 2);
});

test('an acknowledged import rejection restores its previous cache, while a lost reply preserves uncertain inputs', async t => {
  const f = await fixture(t);
  await cp(f.input, f.cache, { recursive: true });
  await assert.rejects(importFreshSetupRestoreSource({
    root: f.root, backupId, appIds: [],
    importBackup: async () => { throw new SetupRestoreError('import-failed'); },
  }), code('import-failed'));
  assert.equal(await readFile(path.join(f.cache, 'youeye/core/core-fixture.tar.enc'), 'utf8'), 'encrypted-core-fixture');
  await assert.rejects(importFreshSetupRestoreSource({
    root: f.root, backupId, appIds: [],
    importBackup: async () => {
      await cp(f.input, f.cache, { recursive: true });
      throw new Error('native import reply lost');
    },
  }), /native import reply lost/);
  assert.equal((await readdir(f.root)).filter(name => name.startsWith('.setup-import-')).length, 1);
  assert.equal(await readFile(path.join(f.cache, 'youeye/core/core-fixture.tar.enc'), 'utf8'), 'encrypted-core-fixture');
});
