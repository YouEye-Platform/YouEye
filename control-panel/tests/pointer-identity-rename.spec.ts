import test from 'node:test';
import assert from 'node:assert/strict';
import { changePointerIdentity } from '../src/lib/pointer/identity-rename';

const change = { oldIssuer: 'https://id.old.test', newIssuer: 'https://id.new.test' };
function fixture(failure: 'none' | 'preflight' | 'apply' | 'before-commit' | 'lost-response' | 'start' | 'restore') {
  let issuer = change.oldIssuer;
  let site = change.oldIssuer;
  const events: string[] = [];
  let starts = 0;
  return {
    events, state: () => ({ issuer, site }),
    operations: {
      transition: async (input: typeof change, check: boolean): Promise<'ready' | 'changed' | 'already-applied'> => {
        events.push(check ? 'check' : 'transition');
        if (failure === 'preflight' || (failure === 'before-commit' && !check)) throw new Error('rejected');
        if (issuer === input.newIssuer) return 'already-applied';
        assert.equal(issuer, input.oldIssuer);
        if (check) return 'ready';
        issuer = input.newIssuer;
        if (failure === 'lost-response' && issuer === change.newIssuer) throw new Error('response lost');
        return 'changed';
      },
      apply: async () => { events.push('apply'); site = change.newIssuer; if (failure === 'apply') throw new Error('route failed'); },
      restore: async () => { events.push('restore'); if (failure === 'restore') throw new Error('restore failed'); site = change.oldIssuer; },
      start: async () => { events.push('start'); starts++; if (starts === 1 && ['start', 'restore'].includes(failure)) throw new Error('not ready'); assert.equal(issuer, site); },
    },
  };
}
test('rename checks the capability before changing routes and starts only after both identities agree', async () => {
  const f = fixture('none');
  await changePointerIdentity(change, f.operations);
  assert.deepEqual(f.events, ['check', 'apply', 'transition', 'start']);
  assert.deepEqual(f.state(), { issuer: change.newIssuer, site: change.newIssuer });
});
test('old Pointer or rejected preflight leaves site and trust untouched', async () => {
  const f = fixture('preflight');
  await assert.rejects(changePointerIdentity(change, f.operations));
  assert.deepEqual(f.events, ['check']);
  assert.deepEqual(f.state(), { issuer: change.oldIssuer, site: change.oldIssuer });
});
for (const failure of ['apply', 'before-commit', 'lost-response', 'start'] as const) {
  test(`restores site and trust after ${failure}`, async () => {
    const f = fixture(failure);
    await assert.rejects(changePointerIdentity(change, f.operations));
    assert.deepEqual(f.state(), { issuer: change.oldIssuer, site: change.oldIssuer });
    assert.equal(f.events.at(-1), 'start');
  });
}
test('incomplete rollback is reported explicitly rather than claimed as success', async () => {
  const f = fixture('restore');
  await assert.rejects(changePointerIdentity(change, f.operations), /recovery is incomplete/);
});
