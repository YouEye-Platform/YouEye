import assert from 'node:assert/strict';
import test from 'node:test';
import { reapplySavedUIConfiguration, reapplySavedUIBridgeToken, reconcileUIBridgeFile, type UIConfiguration } from '../src/lib/infrastructure/ui-configuration';

const saved = [
  'IDENTITY_URL=https://id.example.test', 'IDENTITY_INTERNAL_URL=http://localhost:3002',
  'IDENTITY_CLIENT_ID=existing-ui-client', 'IDENTITY_CLIENT_SECRET=existing-client-secret',
  'JWT_SECRET=existing-session-secret', 'DATABASE_URL=postgresql://owner:existing-db-secret@postgres:5432/youeye_ui',
  'UI_EXTERNAL_URL=https://example.test', 'NODE_ENV=production',
].join('\n');

test('a recreated UI reuses persistent database, OAuth client and session authority through normal configuration', async () => {
  let configured: UIConfiguration | undefined;
  assert.equal(await reapplySavedUIConfiguration(true, async value => { configured = value; }, async () => saved), true);
  assert.deepEqual(configured, {
    identity_url: 'https://id.example.test', identity_internal_url: 'http://localhost:3002',
    client_id: 'existing-ui-client', client_secret: 'existing-client-secret',
    jwt_secret: 'existing-session-secret', database_url: 'postgresql://owner:existing-db-secret@postgres:5432/youeye_ui',
    domain: 'example.test', base_url: 'https://example.test',
  });
});

test('a configured appliance with missing persistent authority cannot be declared repaired', async () => {
  let applied = false;
  await assert.rejects(reapplySavedUIConfiguration(true, async () => { applied = true; }, async () => undefined),
    /Persistent UI configuration is unavailable/);
  assert.equal(applied, false);
});

test('a fresh appliance without saved configuration waits for normal setup', async () => {
  assert.equal(await reapplySavedUIConfiguration(false, async () => assert.fail('Unexpected configuration'), async () => undefined), false);
});

test('a pre-setup placeholder does not create client or session credentials', async () => {
  assert.equal(await reapplySavedUIConfiguration(false, async () => assert.fail('Unexpected configuration'), async () => '# pending setup\n'), false);
  await assert.rejects(reapplySavedUIConfiguration(true, async () => assert.fail('Unexpected configuration'), async () => '# pending setup\n'),
    /Persistent UI configuration is invalid/);
});

test('ambiguous, incomplete and invalid saved bindings fail before applying or revealing values', async () => {
  for (const text of [saved + '\nJWT_SECRET=private-value', saved.replace('JWT_SECRET=existing-session-secret', ''),
    saved.replace('https://example.test', 'file:///private-value'), saved.replace('postgresql:', 'file:')]) {
    await assert.rejects(reapplySavedUIConfiguration(true, async () => assert.fail('Unexpected configuration'), async () => text),
      error => error instanceof Error && error.message === 'Persistent UI configuration is invalid');
  }
});

test('failed normal Spine configuration remains a failed repair', async () => {
  await assert.rejects(reapplySavedUIConfiguration(true, async () => { throw new Error('Configuration unavailable'); }, async () => saved),
    /Configuration unavailable/);
});

test('recreation and lost finalization reapply the same persistent bridge identity and verify it', async () => {
  const observed: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.equal(await reapplySavedUIBridgeToken(true, async token => {
      observed.push(token); return token;
    }, async () => 'existing-bridge-authority\n'), true);
  }
  assert.deepEqual(observed, ['existing-bridge-authority', 'existing-bridge-authority']);
});

test('missing configured bridge authority fails; fresh setup does not manufacture one', async () => {
  const apply = async () => assert.fail('Unexpected bridge publication');
  await assert.rejects(reapplySavedUIBridgeToken(true, apply, async () => undefined), /authority is unavailable/);
  assert.equal(await reapplySavedUIBridgeToken(false, apply, async () => undefined), false);
});

test('invalid persisted bridge values fail before publication', async () => {
  for (const token of ['', ' \n', 'one\ntwo', 'one\0two']) {
    await assert.rejects(reapplySavedUIBridgeToken(true, async () => assert.fail('Unexpected publication'), async () => token),
      error => error instanceof Error && error.message === 'Persistent UI bridge authority is invalid');
  }
});

test('failed or mismatched bridge readback is a sanitized failed reconciliation', async () => {
  for (const apply of [async () => undefined, async () => 'other-authority', async () => {
    throw new Error('private-authority-must-not-appear');
  }]) {
    await assert.rejects(reapplySavedUIBridgeToken(true, apply, async () => 'existing-authority'),
      error => error instanceof Error && error.message === 'UI bridge authority reconciliation failed');
  }
});

test('repair verifies file authority and permissions before clearing the cached missing token', async () => {
  for (const initial of [undefined, { token: 'stale', mode: '600' }, { token: 'current', mode: '644' }]) {
    let current = initial; const events: string[] = [];
    assert.equal(await reconcileUIBridgeFile('current', async () => { events.push('read'); return current; },
      async () => { events.push('write'); current = { token: 'current', mode: '600' }; },
      async () => { events.push('restart'); }, async () => { events.push('prepare-parent'); }), 'current');
    assert.deepEqual(events, ['read', 'prepare-parent', 'write', 'read', 'restart']);
    events.length = 0;
    assert.equal(await reconcileUIBridgeFile('current', async () => { events.push('read'); return current; },
      async () => assert.fail('Already coherent'), async () => assert.fail('No restart required'),
      async () => assert.fail('No parent preparation required')), 'current');
    assert.deepEqual(events, ['read']);
  }
});

test('failed parent preparation leaves credentials unpublished and cannot activate UI authority', async () => {
  await assert.rejects(reconcileUIBridgeFile('current', async () => undefined,
    async () => assert.fail('No credential write after preparation failure'),
    async () => assert.fail('No activation after preparation failure'),
    async () => { throw Error('Directory preparation failed'); }), /Directory preparation failed/);
});

test('failed bridge file verification cannot activate the replacement authority', async () => {
  for (const value of [undefined, { token: 'other', mode: '600' }, { token: 'current', mode: '644' }]) {
    assert.equal(await reconcileUIBridgeFile('current', async () => value, async () => {},
      async () => assert.fail('Unverified authority cannot activate')), undefined);
  }
  await assert.rejects(reconcileUIBridgeFile('current', async () => undefined,
    async () => { throw Error('Write failed'); }, async () => assert.fail('No restart')), /Write failed/);
});
