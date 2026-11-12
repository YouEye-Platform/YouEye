import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, chmodSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { hasRetainedSetupOperation, withSetupMutation } from '../src/lib/setup/lifecycle';
import { assertSetupReadiness, assertProvisioningStepsComplete } from '../src/lib/setup/readiness';
import type { CoreUpdateStatus } from '../src/lib/spine/client';

const hash = 'a'.repeat(64);
const good: CoreUpdateStatus = { schema: 'youeye.core-status.v1', managed: true, installed: {
  manifest_sha256: hash, accepted_at: '2026-10-28T10:00:00Z', machine_bound: true, payload_observation: 'not-observed',
  release: { version: '0.5.64', tag: 'youeye-v0.5.64', source: 'https://example.test/releases', branch: 'main', sequence: 1 },
} };
test('a successful single-step retry cannot complete other pending or failed setup steps', () => {
  const done = Object.fromEntries(['config', 'caddy', 'dns', 'ai', 'sso_control', 'sso_ui'].map(step => [step, 'done']));
  assert.doesNotThrow(() => assertProvisioningStepsComplete(done));
  for (const step of Object.keys(done)) {
    for (const state of [undefined, 'pending', 'error', 'unknown']) {
      assert.throws(() => assertProvisioningStepsComplete({ ...done, [step]: state, finalize: 'done' }), /still need attention/);
    }
  }
});
test('readiness accepts the matching retained receipt and rejects unknown, damaged and unfinished state', () => {
  assert.doesNotThrow(() => assertSetupReadiness(good, hash));
  for (const bad of [
    { ...good, managed: false }, { ...good, installed: undefined },
    { ...good, installed: { ...good.installed!, machine_bound: false } },
    { ...good, installed: { ...good.installed!, accepted_at: 'invalid' } },
    { ...good, installed: { ...good.installed!, payload_observation: 'unknown' } },
    ...['applying', 'recovering', 'failed', 'unknown'].map(phase => ({ ...good, transaction: { phase, complete: false } })),
  ]) assert.throws(() => assertSetupReadiness(bad as CoreUpdateStatus, hash));
  assert.throws(() => assertSetupReadiness(good, null));
  assert.throws(() => assertSetupReadiness(good, 'b'.repeat(64)));
});

test('setup holds shared System admission through effects and keeps exact failed work for resume', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'youeye-setup-test-'));
  const marker = path.join(directory, 'setup-operation.json');
  const options = { directory, readiness: async () => {} };
  try {
    await assert.rejects(withSetupMutation('owner', 'setup', 'setup:owner', async () => {
      assert.equal(JSON.parse(readFileSync(marker, 'utf8')).operation, 'setup:owner');
      // Cross an actual async boundary before trying concurrent admission.
      // Releasing a lock when returning an unresolved promise must be caught.
      await new Promise<void>(resolve => setImmediate(resolve));
      await assert.rejects(withSetupMutation('owner', 'setup', 'setup:owner', async () => {}, options));
      throw new Error('interrupted');
    }, options), /interrupted/);
    assert.ok(existsSync(marker));
    await assert.rejects(withSetupMutation('other', 'setup', 'setup:other', async () => {}, options), /unfinished/);
    await assert.rejects(withSetupMutation('owner', 'restore', 'restore:owner', async () => {}, options), /unfinished/);
    await withSetupMutation('owner', 'setup', 'setup:owner', async settle => { settle(); }, options);
    assert.equal(existsSync(marker), false);
    // A System reservation arriving after a successful browser read rejects the actual effect.
    writeFileSync(path.join(directory, 'core-reservation.json'), JSON.stringify({ schema: 'youeye.core-lifecycle.v1', request_id: 'system:test', manifest_sha256: hash }), { mode: 0o600 });
    let changed = false;
    await assert.rejects(withSetupMutation('owner', 'setup', 'setup:owner', async () => { changed = true; }, options));
    assert.equal(changed, false);
    assert.equal(existsSync(marker), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});


test('setup status reads retained native completion evidence without creating or changing journals', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'youeye-setup-status-'));
  const marker = path.join(directory, 'setup-operation.json');
  const value = { schema: 'youeye.setup-lifecycle/1', owner: 'owner', kind: 'setup', operation: 'setup:owner' };
  try {
    const absent = path.join(directory, 'absent');
    assert.equal(hasRetainedSetupOperation(absent), false);
    assert.equal(existsSync(absent), false);
    assert.throws(() => hasRetainedSetupOperation('relative'), /Unsafe/);
    writeFileSync(marker, JSON.stringify(value), { mode: 0o600 });
    assert.equal(hasRetainedSetupOperation(directory), true);
    assert.deepEqual(JSON.parse(readFileSync(marker, 'utf8')), value);
    chmodSync(marker, 0o644);
    assert.throws(() => hasRetainedSetupOperation(directory), /Unsafe/);
    chmodSync(marker, 0o600);
    writeFileSync(marker, '{}');
    assert.throws(() => hasRetainedSetupOperation(directory), /Invalid/);
    unlinkSync(marker);
    assert.equal(hasRetainedSetupOperation(directory), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
