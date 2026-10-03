import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { replacePlatformUrls } from '../src/lib/reconfigure/urls';

test('identity label and domain propagation is idempotent and retains managed authority and data', () => {
  const old = 'IDENTITY_URL=https://auth.first.test\nISSUER=http://id.youeye:3002\nAPP_URL=https://notes.first.test\nSECRET=unchanged';
  const origins: [string, string] = ['https://auth.first.test', 'https://login.next.test'];
  const next = replacePlatformUrls(old, 'first.test', 'next.test', origins);
  assert.equal(next, 'IDENTITY_URL=https://login.next.test\nISSUER=http://id.youeye:3002\nAPP_URL=https://notes.next.test\nSECRET=unchanged');
  assert.equal(replacePlatformUrls(next, 'first.test', 'next.test', origins), next);
  assert.equal(replacePlatformUrls('https://auth.first.test', 'first.test', 'new.first.test', ['https://auth.first.test', 'https://login.new.first.test']), 'https://login.new.first.test');
  assert.equal(replacePlatformUrls(old, 'first.test', 'first.test', ['https://auth.first.test', 'https://login.first.test']), old.replace('auth.first', 'login.first'));
});

test('actual durable journal survives interruption, schedules once, and reconciles a new process', async () => {
  const root = await mkdtemp(join(tmpdir(), 'youeye-url-change-'));
  process.env.YOUEYE_RECONFIGURE_JOURNAL = join(root, 'journal.json');
  const journal = await import('../src/lib/reconfigure/journal');
  const originalEnv = { identity: process.env.IDENTITY_URL, control: process.env.CONTROL_EXTERNAL_URL };
  try {
    const change = {
      oldDomain: 'first.test', oldIdentityOrigin: 'https://auth.first.test', oldSubdomains: { identity: 'auth' },
      newDomain: 'next.test', newSubdomains: { identity: 'login', control: 'control' },
      phase: 'applying' as const, processStartedAt: journal.processStartTime,
    };
    await journal.saveReconfigureJournal(change);
    assert.deepEqual(await journal.readReconfigureJournal(), change);
    const order: string[] = [];
    await journal.finishReconfigure({
      restart: true,
      beforeRestart: async () => { order.push('bundle-bookkeeping'); },
      persist: async () => { order.push('durable'); await journal.saveReconfigureJournal({ ...change, phase: 'restart-pending' }); },
      schedule: async () => { order.push('restart'); },
      scheduled: async () => { order.push('receipt'); await journal.saveReconfigureJournal({ ...change, phase: 'restart-scheduled', scheduledAt: Date.now() }); },
      failed: async () => { throw new Error('unexpected'); },
      complete: () => { order.push('response'); },
    });
    assert.deepEqual(order, ['bundle-bookkeeping', 'durable', 'restart', 'receipt', 'response']);
    assert.equal((await journal.readReconfigureJournal())?.phase, 'restart-scheduled');
    process.env.IDENTITY_URL = 'https://login.next.test';
    process.env.CONTROL_EXTERNAL_URL = 'https://control.next.test';
    // Matching env in the original process cannot certify restart recovery.
    assert.ok(await journal.readReconfigureJournal());
    await journal.saveReconfigureJournal({ ...change, phase: 'restart-scheduled', processStartedAt: 0 });
    assert.equal(await journal.readReconfigureJournal(), null);
    // No-op/repeat apply completes without another restart.
    await journal.finishReconfigure({ restart: false, persist: async () => assert.fail(), schedule: async () => assert.fail(), scheduled: async () => assert.fail(), failed: async () => assert.fail(), complete: () => order.push('repeat') });
    assert.equal(order.filter(step => step === 'restart').length, 1);
  } finally {
    if (originalEnv.identity === undefined) delete process.env.IDENTITY_URL; else process.env.IDENTITY_URL = originalEnv.identity;
    if (originalEnv.control === undefined) delete process.env.CONTROL_EXTERNAL_URL; else process.env.CONTROL_EXTERNAL_URL = originalEnv.control;
    delete process.env.YOUEYE_RECONFIGURE_JOURNAL;
    await rm(root, { recursive: true, force: true });
  }
});

test('failed durable write or restart never emits completion; scheduler failure remains retryable', async () => {
  const { finishReconfigure } = await import('../src/lib/reconfigure/journal');
  const order: string[] = [];
  const ops = {
    restart: true, persist: async () => { order.push('persist'); },
    schedule: async () => { order.push('schedule'); throw new Error('Spine unavailable'); },
    scheduled: async () => { order.push('scheduled'); },
    failed: async () => { order.push('retryable'); },
    complete: () => { order.push('complete'); },
  };
  await assert.rejects(finishReconfigure(ops), /Spine unavailable/);
  assert.deepEqual(order, ['persist', 'schedule', 'retryable']);
  order.length = 0;
  await assert.rejects(finishReconfigure({ ...ops, persist: async () => { throw new Error('disk full'); } }), /disk full/);
  assert.deepEqual(order, []);
  await assert.rejects(finishReconfigure({ ...ops, beforeRestart: async () => { throw new Error('bundle bookkeeping failed'); } }), /bundle bookkeeping failed/);
  assert.deepEqual(order, []);
});
