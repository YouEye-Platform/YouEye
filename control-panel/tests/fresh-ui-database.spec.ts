import assert from 'node:assert/strict';
import test from 'node:test';
import { configureFreshUIDatabase, requiresFreshUIDatabase, type FreshUIIdentity, type FreshUIDatabaseOperations } from '../src/lib/infrastructure/fresh-ui-database';

const manifest = 'a'.repeat(64);
const identity: FreshUIIdentity = { schema: 'youeye.core-component.v1', role: 'ui', requestId: `install-${manifest}`, manifestSHA256: manifest, artifactSHA256: 'b'.repeat(64) };
function fixture() {
  const state = { owner: undefined as string | undefined, environment: undefined as string | undefined, created: 0, written: 0, started: 0, inspected: 0 };
  const password = `private:p@ss$'"\\word`;
  const ops: FreshUIDatabaseOperations = {
    assertIdentity: async () => { state.inspected++; },
    credentials: async () => ({ host: '10.96.31.17', port: '5432', user: 'youeye', password }),
    databaseOwner: async () => state.owner,
    createDatabase: async () => { state.created++; state.owner = 'youeye'; },
    readEnvironment: async () => state.environment,
    writeEnvironment: async text => { state.written++; state.environment = text; },
    start: async () => {
      assert.equal(state.owner, 'youeye');
      assert.ok(state.environment?.includes('DATABASE_URL='));
      assert.ok(state.inspected >= 3);
      state.started++;
    },
  };
  return { state, ops, password };
}

test('only exact fresh CP markers before setup request a database bootstrap', async () => {
  const cp = { ...identity, role: 'cp' };
  assert.equal(requiresFreshUIDatabase(cp, false), true);
  for (const marker of [null, identity, { ...cp, requestId: 'update-request' }, { ...cp, manifestSHA256: 'invalid' }]) {
    assert.equal(requiresFreshUIDatabase(marker, false), false);
  }
  assert.equal(requiresFreshUIDatabase(cp, true), false);
  const { state, ops } = fixture();
  await assert.rejects(configureFreshUIDatabase({ ...identity, requestId: 'update-request' }, ops), /Exact fresh/);
  assert.equal(state.inspected, 0);
});

test('fresh binding precedes startup and reconciles without replacing data or issuing identity authority', async () => {
  const { state, ops, password } = fixture();
  await configureFreshUIDatabase(identity, ops);
  assert.equal(state.created, 1);
  assert.equal(state.written, 1);
  const line = state.environment!.split('\n').find(x => x.startsWith('DATABASE_URL='))!;
  const url = new URL(line.slice('DATABASE_URL='.length));
  assert.equal(decodeURIComponent(url.password), password);
  assert.equal(url.pathname, '/youeye_ui');
  assert.equal(url.hostname, '10.96.31.17');
  assert.doesNotMatch(state.environment!, /IDENTITY_|JWT_SECRET|CREATE TABLE/);
  await configureFreshUIDatabase(identity, ops);
  assert.equal(state.created, 1);
  assert.equal(state.written, 1);
  assert.equal(state.started, 2);
});

test('foreign database ownership and existing environment prevent binding and startup', async () => {
  const foreign = fixture(); foreign.state.owner = 'other-owner';
  await assert.rejects(configureFreshUIDatabase(identity, foreign.ops), /ownership/);
  assert.equal(foreign.state.created + foreign.state.written + foreign.state.started, 0);
  const configured = fixture(); configured.state.environment = 'IDENTITY_CLIENT_ID=existing\n';
  await assert.rejects(configureFreshUIDatabase(identity, configured.ops), /saved configuration/);
  assert.equal(configured.state.created + configured.state.written + configured.state.started, 0);
  assert.equal(configured.state.environment, 'IDENTITY_CLIENT_ID=existing\n');
});

test('lost database-create acknowledgement reconciles ownership before another attempt', async () => {
  const { state, ops } = fixture();
  const create = ops.createDatabase;
  ops.createDatabase = async () => { await create(); throw new Error('lost acknowledgement'); };
  await assert.rejects(configureFreshUIDatabase(identity, ops), /lost acknowledgement/);
  assert.equal(state.written + state.started, 0);
  await configureFreshUIDatabase(identity, ops);
  assert.equal(state.created, 1);
  assert.equal(state.started, 1);
});

test('changed marker, unverified environment and invalid bindings never start UI', async () => {
  const changed = fixture();
  changed.ops.assertIdentity = async () => { if (++changed.state.inspected === 2) throw new Error('changed marker'); };
  await assert.rejects(configureFreshUIDatabase(identity, changed.ops), /changed marker/);
  assert.equal(changed.state.written + changed.state.started, 0);
  const lost = fixture(); lost.ops.writeEnvironment = async () => {};
  await assert.rejects(configureFreshUIDatabase(identity, lost.ops), /readback/);
  assert.equal(lost.state.started, 0);
  const bad = fixture(); bad.ops.credentials = async () => ({ host: 'host\nBAD=1', port: '5432', user: 'youeye', password: 'private' });
  await assert.rejects(configureFreshUIDatabase(identity, bad.ops), /binding is invalid/);
  assert.equal(bad.state.created + bad.state.written + bad.state.started, 0);
});
