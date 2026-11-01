import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, link, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import {
  runSetupRestore, SetupRestoreError, SetupRestoreStore, setupRestoreTargetIdentity,
  type SetupRestoreIdentity, type SetupRestoreIO,
} from '../src/lib/setup/restore-recovery';
import { withSetupMutation } from '../src/lib/setup/lifecycle';

const source = 'a'.repeat(64);
const identity: SetupRestoreIdentity = {
  operationId: 'a1234567-1234-4234-8234-123456789abc',
  ownerId: 'owner', sessionId: 'session', mediaId: 'drive',
  backupId: 'backup-20261029T120000Z-1234abcd',
  appIds: ['notes', 'cinema'], target: setupRestoreTargetIdentity('fixture-machine'),
};
const code = (expected: string) => (error: unknown) => error instanceof SetupRestoreError && error.code === expected;

async function fixture(t: { after: (work: () => Promise<void>) => void }) {
  const directory = await mkdtemp(path.join(tmpdir(), 'setup-restore-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new SetupRestoreStore(path.join(directory, 'records'));
  const effects = { imports: 0, restores: 0, removes: 0, databases: 0, configWrites: 0, patches: 0, restarts: 0, settles: 0 };
  let setupCompleted = false;
  const io: SetupRestoreIO = {
    store,
    importSource: async () => { effects.imports++; return source; },
    restore: async checkpoint => {
      effects.restores++;
      await checkpoint.step('remove-current-apps', 'never', async () => { effects.removes++; });
      await checkpoint.step('restore-databases', 'never', async () => { effects.databases++; });
    },
    setupCompleted: async () => setupCompleted,
    completeSetup: async () => { effects.patches++; setupCompleted = true; },
    restartControl: async () => { effects.restarts++; },
    settle: () => { effects.settles++; },
  };
  return { directory, store, effects, io };
}

test('an early validation failure retains exact admission and resumes the same operation', async t => {
  const f = await fixture(t);
  const options = { directory: path.join(f.directory, 'admission'), readiness: async () => {} };
  f.io.importSource = async () => { throw new SetupRestoreError('import-failed'); };
  await assert.rejects(withSetupMutation(identity.ownerId, 'restore', identity.operationId,
    settle => runSetupRestore(identity, 'start', { ...f.io, settle }), options), code('import-failed'));
  const status = (await f.store.readStatus(identity.operationId))!.status;
  assert.equal(status.status, 'failed');
  assert.equal(status.phase, 'prepared');
  assert.equal(status.recovery, 'resume');
  assert.doesNotMatch(JSON.stringify(status), /fixture recovery|private path/);
  let changed = false;
  await assert.rejects(withSetupMutation(identity.ownerId, 'restore', randomUUID(),
    async () => { changed = true; }, options), /unfinished/);
  assert.equal(changed, false);
  f.io.importSource = async () => source;
  await withSetupMutation(identity.ownerId, 'restore', identity.operationId,
    settle => runSetupRestore(identity, 'resume', { ...f.io, settle }), options);
  await assert.rejects(stat(path.join(options.directory, 'setup-operation.json')), { code: 'ENOENT' });
  assert.equal(f.effects.removes, 1);
  assert.equal(f.effects.restarts, 1);
});

test('owner, session, VM, drive, backup and app selection cannot change on resume', async t => {
  const f = await fixture(t);
  f.io.importSource = async () => { throw new SetupRestoreError('import-failed'); };
  await assert.rejects(runSetupRestore(identity, 'start', f.io), code('import-failed'));
  const original = await readFile(path.join(f.store.directory, `${identity.operationId}.json`), 'utf8');
  for (const change of [
    { ownerId: 'foreign-owner' }, { sessionId: 'foreign-session' }, { target: 'b'.repeat(64) },
    { mediaId: 'another-drive' }, { backupId: 'backup-20261029T130000Z-1234abcd' }, { appIds: ['notes'] },
  ]) {
    await assert.rejects(runSetupRestore({ ...identity, ...change }, 'resume', f.io), code('identity-mismatch'));
    assert.equal(await readFile(path.join(f.store.directory, `${identity.operationId}.json`), 'utf8'), original);
  }
  await assert.rejects(runSetupRestore({ ...identity, operationId: randomUUID() }, 'resume', f.io), code('operation-missing'));
  await assert.rejects(runSetupRestore(identity, 'start', f.io), code('resume-required'));
  f.io.importSource = async () => source;
  await runSetupRestore({ ...identity, appIds: ['cinema', 'notes'] }, 'resume', f.io);
  assert.equal(f.effects.removes, 1);
});

test('a changed source cannot replay completed or replacement steps', async t => {
  const f = await fixture(t);
  f.io.restore = async checkpoint => {
    await checkpoint.step('remove-current-apps', 'never', async () => { f.effects.removes++; });
    await checkpoint.step('restore-config', 'replace', async () => {
      f.effects.configWrites++;
      throw new Error('configuration assignment reply lost');
    });
  };
  await assert.rejects(runSetupRestore(identity, 'start', f.io), code('restore-failed'));
  f.io.importSource = async () => 'b'.repeat(64);
  await assert.rejects(runSetupRestore(identity, 'resume', f.io), code('source-mismatch'));
  assert.equal(f.effects.removes, 1);
  assert.equal(f.effects.configWrites, 1);
  assert.equal((await f.store.read(identity.operationId))!.source, source);
  f.io.importSource = async () => source;
  f.io.restore = async checkpoint => {
    await checkpoint.step('remove-current-apps', 'never', async () => { f.effects.removes++; });
    await checkpoint.step('restore-config', 'replace', async () => { f.effects.configWrites++; });
  };
  await runSetupRestore(identity, 'resume', f.io);
  assert.equal(f.effects.removes, 1);
  assert.equal(f.effects.configWrites, 2);
});

test('an unacknowledged native import cannot be retried while it may still be running', async t => {
  const f = await fixture(t);
  f.io.importSource = async () => { f.effects.imports++; throw new Error('transport reply lost'); };
  await assert.rejects(runSetupRestore(identity, 'start', f.io), code('restore-failed'));
  assert.equal((await f.store.readStatus(identity.operationId))!.status.recovery, 'operator-required');
  await assert.rejects(runSetupRestore(identity, 'resume', f.io), code('operator-required'));
  assert.equal(f.effects.imports, 1);
  assert.equal(f.effects.restores, 0);
});

test('an active asynchronous run offers no resume and rejects a concurrent same-operation writer', async t => {
  const f = await fixture(t);
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.io.restore = async checkpoint => checkpoint.step('restore-app:notes', 'never', async () => {
    f.effects.restores++;
    entered();
    await gate;
  });
  const running = runSetupRestore(identity, 'start', f.io);
  try {
    await waiting;
    const current = (await f.store.readStatus(identity.operationId))!.status;
    assert.equal(current.active, true);
    assert.equal(current.status, 'running');
    assert.equal(current.recovery, 'none');
    await assert.rejects(runSetupRestore(identity, 'resume', f.io), code('operation-active'));
    assert.equal(f.effects.restores, 1);
    assert.equal(f.effects.restarts, 0);
  } finally { release(); }
  await running;
  assert.equal((await f.store.readStatus(identity.operationId))!.status.active, false);
});

test('a missing early status reader cannot take the first submission lease', async t => {
  const f = await fixture(t);
  const read = f.store.read.bind(f.store);
  let entered!: () => void, release!: () => void, first = true;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.store.read = async id => {
    if (first) {
      first = false;
      entered();
      await gate;
      return null;
    }
    return read(id);
  };
  const early = f.store.readStatus(identity.operationId);
  await waiting;
  try { await runSetupRestore(identity, 'start', f.io); }
  finally { release(); }
  assert.equal(await early, null);
  assert.equal((await f.store.readStatus(identity.operationId))!.status.status, 'completed');
  assert.equal(f.effects.restores, 1);
});

for (const step of ['remove-current-apps', 'restore-volumes', 'restore-databases', 'restore-caddy', 'restore-pihole', 'restore-app:notes']) {
  test(`unknown partial ${step} requires an operator without importing or replaying`, async t => {
    const f = await fixture(t);
    f.io.restore = async checkpoint => checkpoint.step(step, 'never', async () => {
      f.effects.restores++;
      throw new Error('effect may have applied; lost reply');
    });
    await assert.rejects(runSetupRestore(identity, 'start', f.io), code('restore-failed'));
    const retained = (await f.store.readStatus(identity.operationId))!;
    assert.equal(retained.status.recovery, 'operator-required');
    assert.equal(retained.status.active, false);
    await assert.rejects(runSetupRestore(identity, 'resume', f.io), code('operator-required'));
    assert.equal(f.effects.restores, 1);
    assert.equal(f.effects.imports, 1);
    assert.equal(f.effects.settles, 0);
  });
}

test('lost setup-completion reply finalizes without importing or restoring again', async t => {
  const f = await fixture(t);
  const patch = f.io.completeSetup;
  f.io.completeSetup = async () => { await patch(); throw new Error('completion reply lost'); };
  await assert.rejects(runSetupRestore(identity, 'start', f.io), code('restore-failed'));
  const retained = (await f.store.readStatus(identity.operationId))!;
  assert.equal(retained.status.phase, 'finalizing');
  assert.equal(retained.status.recovery, 'finalize');
  f.io.importSource = async () => { throw new Error('media no longer present'); };
  f.io.restore = async () => { assert.fail('restore must not repeat during finalization'); };
  await runSetupRestore(identity, 'resume', f.io);
  assert.equal(f.effects.patches, 1);
  assert.equal(f.effects.imports, 1);
  assert.equal(f.effects.restores, 1);
  assert.equal(f.effects.restarts, 1);
  assert.equal(f.effects.settles, 1);
});

test('lost restart reply remains operator-required and cannot duplicate the restart or restore', async t => {
  const f = await fixture(t);
  f.io.restartControl = async () => { f.effects.restarts++; throw new Error('restart reply lost'); };
  await assert.rejects(runSetupRestore(identity, 'start', f.io), code('restore-failed'));
  assert.equal((await f.store.readStatus(identity.operationId))!.status.recovery, 'operator-required');
  await assert.rejects(runSetupRestore(identity, 'resume', f.io), code('operator-required'));
  assert.equal(f.effects.restores, 1);
  assert.equal(f.effects.restarts, 1);
  assert.equal(f.effects.settles, 0);
});

test('completed response loss and failed marker settlement preserve readable completion and skip all effects', async t => {
  const f = await fixture(t);
  f.io.settle = () => { throw new Error('settlement interrupted'); };
  await assert.rejects(runSetupRestore(identity, 'start', f.io), code('restore-failed'));
  assert.equal((await f.store.readStatus(identity.operationId))!.status.status, 'completed');
  f.io.settle = () => { f.effects.settles++; };
  await runSetupRestore(identity, 'resume', f.io);
  await runSetupRestore(identity, 'resume', f.io);
  assert.equal(f.effects.imports, 1);
  assert.equal(f.effects.restores, 1);
  assert.equal(f.effects.patches, 1);
  assert.equal(f.effects.restarts, 1);
  assert.equal(f.effects.settles, 2);
});

test('completed steps survive a failure between restore and finalization', async t => {
  const f = await fixture(t);
  f.io.restore = async checkpoint => {
    await checkpoint.step('restore-app:notes', 'never', async () => { f.effects.restores++; });
    throw new Error('after final effect, before restored phase');
  };
  await assert.rejects(runSetupRestore(identity, 'start', f.io), code('restore-failed'));
  f.io.restore = async checkpoint => {
    await checkpoint.step('restore-app:notes', 'never', async () => { f.effects.restores++; });
  };
  await runSetupRestore(identity, 'resume', f.io);
  assert.equal(f.effects.restores, 1);
});

test('changed retry policy retains original step evidence and durably requires an operator', async t => {
  const f = await fixture(t);
  f.io.restore = async checkpoint => {
    await checkpoint.step('remove-current-apps', 'never', async () => { f.effects.removes++; });
    throw new Error('stopped between completed gates');
  };
  await assert.rejects(runSetupRestore(identity, 'start', f.io), code('restore-failed'));
  f.io.restore = async checkpoint =>
    checkpoint.step('remove-current-apps', 'replace', async () => { assert.fail('changed policy replayed'); });
  await assert.rejects(runSetupRestore(identity, 'resume', f.io), code('operator-required'));
  const retained = (await f.store.readStatus(identity.operationId))!;
  assert.equal(retained.status.recovery, 'operator-required');
  assert.deepEqual(retained.record.steps['remove-current-apps'], { state: 'completed', retry: 'never' });
  assert.equal(retained.record.operatorRequired, true);
  await assert.rejects(runSetupRestore(identity, 'resume', f.io), code('operator-required'));
  assert.equal(f.effects.imports, 2);
  assert.equal(f.effects.removes, 1);
});

test('record damage, symlinks, hardlinks and insecure permissions fail closed', async t => {
  const f = await fixture(t);
  await runSetupRestore(identity, 'start', f.io);
  const filename = path.join(f.store.directory, `${identity.operationId}.json`);
  const original = await readFile(filename);
  for (const invalid of [
    '{', '{}',
    JSON.stringify({ ...JSON.parse(original.toString()), status: 'failed' }),
    JSON.stringify({ ...JSON.parse(original.toString()), steps: { 'restore-app:notes': { state: 'started', retry: 'never' } } }),
  ]) {
    await writeFile(filename, invalid);
    await assert.rejects(f.store.readStatus(identity.operationId), code('state-unavailable'));
    await assert.rejects(runSetupRestore(identity, 'resume', f.io), code('state-unavailable'));
  }
  await writeFile(filename, original);
  await chmod(filename, 0o644);
  await assert.rejects(f.store.read(identity.operationId), code('state-unavailable'));
  await chmod(filename, 0o600);
  const alias = path.join(f.directory, 'alias');
  await link(filename, alias);
  await assert.rejects(f.store.read(identity.operationId), code('state-unavailable'));
  await rm(alias);
  await rm(filename);
  await writeFile(alias, original, { mode: 0o600 });
  await symlink(alias, filename);
  await assert.rejects(f.store.read(identity.operationId), code('state-unavailable'));
  assert.equal(f.effects.restores, 1);
});

for (const cutoff of ['partial-effect', 'effect-completed', 'restored', 'restart-requested', 'completed']) {
  test(`SIGKILL cutoff at ${cutoff} retains exclusion and deterministic recovery`, async t => {
    const f = await fixture(t);
    const lifecycle = path.join(f.directory, 'admission');
    const recoveryURL = pathToFileURL(path.resolve('src/lib/setup/restore-recovery.ts')).href;
    const lifecycleURL = pathToFileURL(path.resolve('src/lib/setup/lifecycle.ts')).href;
    const script = `
      import { writeFileSync } from 'node:fs';
      import { SetupRestoreStore, runSetupRestore } from ${JSON.stringify(recoveryURL)};
      import { withSetupMutation } from ${JSON.stringify(lifecycleURL)};
      const identity = ${JSON.stringify(identity)};
      const store = new SetupRestoreStore(${JSON.stringify(f.store.directory)});
      const cutoff = ${JSON.stringify(cutoff)};
      const kill = () => process.kill(process.pid, 'SIGKILL');
      const write = store.write.bind(store);
      store.write = async state => {
        await write(state);
        if ((cutoff === 'restored' && state.phase === 'restored')
          || (cutoff === 'restart-requested' && state.restart === 'requested')
          || (cutoff === 'completed' && state.phase === 'completed')) kill();
      };
      await withSetupMutation(identity.ownerId, 'restore', identity.operationId, settle =>
        runSetupRestore(identity, 'start', {
          store, importSource: async () => ${JSON.stringify(source)},
          restore: async checkpoint => {
            await checkpoint.step('restore-app:notes', 'never', async () => {
              writeFileSync(${JSON.stringify(path.join(f.directory, 'effect'))}, 'applied');
              if (cutoff === 'partial-effect') kill();
            });
            if (cutoff === 'effect-completed') kill();
          },
          setupCompleted: async () => false, completeSetup: async () => {},
          restartControl: async () => {}, settle,
        }), { directory: ${JSON.stringify(lifecycle)}, readiness: async () => {} });
    `;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-'], {
      stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000,
    });
    let stderr = '';
    child.stderr.on('data', data => { stderr += data; });
    const exited = new Promise<string | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (exitCode, signal) => {
        if (exitCode !== null) reject(new Error(`cutoff fixture exited ${exitCode}: ${stderr}`));
        else resolve(signal);
      });
    });
    child.stdin.end(script);
    assert.equal(await exited, 'SIGKILL');
    assert.equal(await readFile(path.join(f.directory, 'effect'), 'utf8'), 'applied');
    const status = (await f.store.readStatus(identity.operationId))!.status;
    assert.equal(status.active, false);
    assert.equal(status.recovery, cutoff === 'partial-effect' || cutoff === 'restart-requested'
      ? 'operator-required' : cutoff === 'restored' ? 'finalize' : cutoff === 'completed' ? 'none' : 'resume');
    const options = { directory: lifecycle, readiness: async () => {} };
    await assert.rejects(withSetupMutation('foreign-owner', 'restore', randomUUID(), async () => {}, options), /unfinished/);
    f.io.restore = async checkpoint => {
      await checkpoint.step('restore-app:notes', 'never', async () => { assert.fail('completed effect replayed'); });
    };
    const resume = () => withSetupMutation(identity.ownerId, 'restore', identity.operationId,
      settle => runSetupRestore(identity, 'resume', { ...f.io, settle }), options);
    if (status.recovery === 'operator-required') {
      await assert.rejects(resume(), code('operator-required'));
      assert.equal(f.effects.imports, 0);
    } else {
      await resume();
      assert.equal((await f.store.readStatus(identity.operationId))!.status.status, 'completed');
      assert.equal(f.effects.imports, cutoff === 'effect-completed' ? 1 : 0);
      await assert.rejects(stat(path.join(lifecycle, 'setup-operation.json')), { code: 'ENOENT' });
    }
  });
}
