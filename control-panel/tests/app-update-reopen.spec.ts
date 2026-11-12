import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import ts from 'typescript';

function fixture(mode: 'own' | 'shared' = 'own', engineDesired = true, healthy = true) {
  const engine = mode === 'own' ? 'app-fixture-db' : 'youeye-postgres';
  const states = new Map([['app-fixture-main', 'Stopped'], [engine, 'Stopped']]);
  const events: string[] = [];
  const plan = { postgres: { mode, engine, adminRole: 'postgres' } };
  const record = {
    phase: 'cleanup', commit: { receipt: 'committed' },
    steps: [{ phase: 'applying' }],
    originalRunning: {
      'app-fixture-main': engineDesired,
      ...(mode === 'own' ? { [engine]: engineDesired } : {}),
    },
  };
  const output = ts.transpileModule(readFileSync(join(import.meta.dirname,
    '../src/lib/market/update-provider.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: any = {};
  new Function('require', 'exports', output)((name: string) => {
    if (name === '@/lib/incus/snapshot') return {
      containerState: async (name: string) => states.get(name),
      startContainer: async (name: string) => { events.push(`start:${name}`); states.set(name, 'Running'); },
      stopContainer: async (name: string) => { events.push(`stop:${name}`); states.set(name, 'Stopped'); },
      waitForRunning: async (name: string) => { assert.equal(states.get(name), 'Running'); },
    };
    if (name === './health') return {
      waitForPostgresHealth: async (name: string, user: string) => {
        events.push(`ready:${name}:${user}`);
        assert.equal(name, engine);
        assert.equal(states.get(engine), 'Running');
        return healthy;
      },
    };
    return {};
  }, exports);
  const provider = new exports.IncusAppUpdateProvider();
  provider.load = () => plan;
  provider.ensureCurrentSecurity = async () => {};
  provider.optionalFence = () => ({ operationId: 'fixture' });
  provider.postgres = async () => ({
    unfence: async (_fence: unknown, phase: string) => {
      events.push(`unfence:${phase}`);
      assert.equal(states.get(engine), 'Running', 'Cannot reconcile a stopped database');
      assert.equal(states.get('app-fixture-main'), 'Stopped', 'Writers must remain stopped');
    },
  });
  provider.bootFence = async (_record: unknown, fenced: boolean) => {
    events.push(fenced ? 'verify-boot-fence' : 'release-boot-fence');
  };
  provider.ingress = async () => { events.push('release-ingress'); };
  return { provider, record, states, events, engine };
}

test('committed cleanup after reboot starts its app-owned database before unfencing and reopening writers', async () => {
  const f = fixture();
  await f.provider.reopen(f.record);
  assert.deepEqual(f.events, [
    'verify-boot-fence', 'start:app-fixture-db', 'ready:app-fixture-db:postgres', 'unfence:original',
    'start:app-fixture-main', 'release-boot-fence', 'release-ingress',
  ]);
  assert.equal(f.states.get(f.engine), 'Running');
});

test('an originally stopped app-owned database is stopped again after temporary grant reconciliation', async () => {
  const f = fixture('own', false);
  await f.provider.reopen(f.record);
  assert.deepEqual(f.events, [
    'verify-boot-fence', 'start:app-fixture-db', 'ready:app-fixture-db:postgres', 'unfence:original',
    'stop:app-fixture-db', 'release-boot-fence', 'release-ingress',
  ]);
  assert.equal(f.states.get('app-fixture-main'), 'Stopped');
  assert.equal(f.states.get(f.engine), 'Stopped');
});

test('database readiness failure preserves writer and traffic fences for later committed cleanup', async () => {
  const f = fixture('own', true, false);
  await assert.rejects(f.provider.reopen(f.record), /not ready/);
  assert.deepEqual(f.events, ['verify-boot-fence', 'start:app-fixture-db', 'ready:app-fixture-db:postgres']);
  assert.equal(f.states.get('app-fixture-main'), 'Stopped');
});

test('app recovery never starts a stopped shared platform database', async () => {
  const f = fixture('shared');
  await assert.rejects(f.provider.reopen(f.record), /stopped database/);
  assert.deepEqual(f.events, ['verify-boot-fence', 'unfence:original']);
  assert.equal(f.states.get(f.engine), 'Stopped');
});

test('changed runtime identity is refused before starting the app-owned database', async () => {
  const f = fixture();
  f.provider.bootFence = async () => { throw new Error('App runtime identity changed outside the update'); };
  await assert.rejects(f.provider.reopen(f.record), /identity changed/);
  assert.deepEqual(f.events, []);
  assert.equal(f.states.get(f.engine), 'Stopped');
});
