import assert from 'node:assert/strict';
import { chmod, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runCoreSchemaOnce, coreSchemaComponent, coreSchemaStatus } from '../src/lib/updates/core-schema';

const component = { schema: 'youeye.core-component.v1', role: 'cp', requestId: 'fixture-request', manifestSHA256: 'a'.repeat(64), artifactSHA256: 'b'.repeat(64) };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'core-schema-'));
  const paths = { component: join(root, 'component.json'), receipts: join(root, 'receipts') };
  await writeFile(paths.component, JSON.stringify(component), { mode: 0o600 });
  return { root, paths };
}

test('concurrent CP/ID and process restarts share one exact completed schema attempt', async () => {
  const { root, paths } = await fixture();
  try {
    assert.equal((await coreSchemaStatus('cp', paths)).state, 'pending');
    let calls = 0;
    let started!: () => void; const entered = new Promise<void>(r => { started = r; });
    let complete!: () => void; const finish = new Promise<void>(r => { complete = r; });
    const first = runCoreSchemaOnce('cp', async () => { calls++; started(); await finish; }, paths);
    await entered;
    assert.equal((await coreSchemaStatus('cp', paths)).state, 'started');
    await assert.rejects(runCoreSchemaOnce('cp', async () => { calls++; }, paths), /running or uncertain/);
    complete(); await first;
    assert.equal((await coreSchemaStatus('cp', paths)).state, 'completed');
    await runCoreSchemaOnce('cp', async () => { calls++; }, paths);
    assert.equal(calls, 1);
    // JSON property order does not create another operation.
    await writeFile(paths.component, JSON.stringify({ artifactSHA256: component.artifactSHA256, manifestSHA256: component.manifestSHA256, requestId: component.requestId, role: component.role, schema: component.schema }), { mode: 0o600 });
    await runCoreSchemaOnce('cp', async () => { calls++; }, paths);
    assert.equal(calls, 1);
    const receipts = await readdir(paths.receipts);
    assert.equal(receipts.length, 1);
    assert.equal(JSON.parse(await readFile(join(paths.receipts, receipts[0]), 'utf8')).state, 'completed');
  } finally { await rm(root, { recursive: true }); }
});

test('uncertain schema effects never retry and a separately owned historical restore has its own receipt', async () => {
  const { root, paths } = await fixture();
  try {
    let calls = 0;
    await assert.rejects(runCoreSchemaOnce('cp', async () => { calls++; throw new Error('private failure'); }, paths), /outcome is uncertain/);
    await assert.rejects(runCoreSchemaOnce('cp', async () => { calls++; }, paths), /running or uncertain/);
    assert.equal(calls, 1);
    await runCoreSchemaOnce('cp', async () => { calls++; }, paths, 'owned-full-restore');
    await runCoreSchemaOnce('cp', async () => { calls++; }, paths, 'owned-full-restore');
    assert.equal(calls, 2);
  } finally { await rm(root, { recursive: true }); }
});

test('selected damaged or foreign component markers cannot fall back to legacy schema initialization', async () => {
  const { root, paths } = await fixture();
  try {
    await assert.rejects(coreSchemaComponent('ui', paths.component), /Invalid/);
    await chmod(paths.component, 0o666);
    await assert.rejects(runCoreSchemaOnce('cp', async () => { assert.fail('ran with unsafe authority'); }, paths));
    await rm(paths.component); await symlink('missing', paths.component);
    await assert.rejects(runCoreSchemaOnce('cp', async () => { assert.fail('dangling marker became legacy'); }, paths));
    await rm(paths.component);
    let legacy = 0; await runCoreSchemaOnce('cp', async () => { legacy++; }, paths); assert.equal(legacy, 1);
    await writeFile(join(root, 'core-artifact-sha256'), 'b'.repeat(64), { mode: 0o600 });
    await assert.rejects(runCoreSchemaOnce('cp', async () => { assert.fail('missing selected marker became legacy'); }, paths));
  } finally { await rm(root, { recursive: true }); }
});

test('a changed native marker cannot receive completion evidence for the old schema attempt', async () => {
  const { root, paths } = await fixture();
  try {
    await assert.rejects(runCoreSchemaOnce('cp', async () => {
      await writeFile(paths.component, JSON.stringify({ ...component, requestId: 'another-native-request' }), { mode: 0o600 });
    }, paths), /changed during/);
    const files = await readdir(paths.receipts);
    assert.equal(files.length, 1);
    assert.equal(JSON.parse(await readFile(join(paths.receipts, files[0]), 'utf8')).state, 'unknown');
  } finally { await rm(root, { recursive: true }); }
});
