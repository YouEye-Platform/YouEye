import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fakeIncus, loadSnapshot } from './fixtures/update-provider-harness';

const SRC = join(import.meta.dirname, '../src');

test('a stop is clean, with a 60 s default and 120 s for a database, and does nothing to a stopped container', async () => {
  const incus = fakeIncus();
  incus.addInstance('app-a', 'Running');
  incus.addInstance('app-b', 'Stopped');
  const snapshot = loadSnapshot(incus);
  assert.equal(snapshot.stopTimeoutSec(), 60);
  assert.equal(snapshot.stopTimeoutSec('app'), 60);
  assert.equal(snapshot.stopTimeoutSec('database'), 120);
  await snapshot.stopContainer('app-a');
  await snapshot.stopContainer('app-b');
  incus.instances.get('app-a')!.status = 'Running';
  await snapshot.stopContainer('app-a', { timeoutSec: 120 });
  assert.deepEqual(incus.log, ['stop:app-a:60', 'stop:app-a:120']);
});

test('a clean stop that times out throws and never kills', async () => {
  const incus = fakeIncus();
  incus.addInstance('app-a', 'Running');
  incus.stuck.add('app-a');
  const snapshot = loadSnapshot(incus);
  await assert.rejects(snapshot.stopContainer('app-a', { timeoutSec: 5 }), (error: any) =>
    error instanceof snapshot.ContainerStopTimeoutError && error.container === 'app-a' && error.timeoutSec === 5);
  assert.deepEqual(incus.log, ['stop:app-a:5']);
  assert.equal(incus.instances.get('app-a')!.status, 'Running');
});

test('a stop that Incus refuses is not a timeout: the container keeps its whole time to stop', async () => {
  const incus = fakeIncus();
  incus.addInstance('app-a', 'Running');
  incus.refused.add('app-a');
  const snapshot = loadSnapshot(incus);
  // Still running when the time is up: only then is it a timeout.
  await assert.rejects(snapshot.stopContainer('app-a', { timeoutSec: 60 }), (error: any) =>
    error instanceof snapshot.ContainerStopTimeoutError && error.timeoutSec === 60);
  assert.equal(incus.clock.t, 60_000, 'the timeout is reported after the timeout, not after 0 s');
  // The refused stop never reached the container: it is asked again every 5 s, each time with the time that is left.
  assert.deepEqual(incus.log, [60, 55, 50, 45, 40, 35, 30, 25, 20, 15, 10, 5].map(left => `stop:app-a:${left}`));

  // It stops meanwhile (the other operation's stop went through): a clean stop, no error.
  const started = incus.clock.t;
  const states = incus.incusRequest;
  let reads = 0;
  const stopping = loadSnapshot({ ...incus, incusRequest: async (method: string, url: string, body?: unknown) => {
    if (method === 'GET' && url.endsWith('/state') && ++reads === 4) incus.instances.get('app-a')!.status = 'Stopped';
    return states(method, url, body);
  } });
  await stopping.stopContainer('app-a', { timeoutSec: 60 });
  assert.ok(incus.clock.t - started < 60_000);
});

test('a refused stop is asked again: the container gets its shutdown signal once Incus is free, and is not killed', async (t) => {
  const incus = fakeIncus();
  incus.addInstance('app-a', 'Running');
  incus.refused.add('app-a');
  t.mock.method(console, 'warn', () => assert.fail('nothing to warn about: it stopped cleanly'));
  // The other operation on the instance ends 12 s in.
  const request = incus.incusRequest;
  const snapshot = loadSnapshot({ ...incus, incusRequest: async (method: string, url: string, body?: unknown) => {
    if (incus.clock.t >= 12_000) incus.refused.delete('app-a');
    return request(method, url, body);
  } });
  await snapshot.stopContainerOrForce('app-a', { timeoutSec: 60 });
  assert.deepEqual(incus.log, ['stop:app-a:60', 'stop:app-a:55', 'stop:app-a:50', 'stop:app-a:45']);
  assert.equal(incus.instances.get('app-a')!.status, 'Stopped');
  assert.equal(incus.clock.t, 15_000);

  // A stop that Incus took is not asked twice: a container that ignores it is only waited for. Incus answers at once
  // and the container keeps running, so the wait polls it for the whole timeout.
  incus.addInstance('app-b', 'Running');
  incus.log.length = 0;
  const ignored = loadSnapshot({ ...incus, incusRequest: async (method: string, url: string, body?: any) => {
    if (method === 'PUT' && url.endsWith('/app-b/state')) {
      incus.log.push(`stop:app-b:${body.timeout}`);
      return { type: 'sync', status_code: 200 };
    }
    return request(method, url, body);
  } });
  const asked = incus.clock.t;
  await assert.rejects(ignored.stopContainer('app-b', { timeoutSec: 30 }), /did not stop within 30 s/);
  assert.equal(incus.clock.t - asked, 30_000, 'waited for its whole timeout');
  assert.deepEqual(incus.log, ['stop:app-b:30']);
});

test('a refused stop is forced only after the timeout, and a container that vanished rethrows the refusal', async (t) => {
  const incus = fakeIncus();
  incus.addInstance('app-a', 'Running');
  incus.refused.add('app-a');
  t.mock.method(console, 'warn', () => {});
  const snapshot = loadSnapshot(incus);
  await snapshot.stopContainerOrForce('app-a', { timeoutSec: 60 });
  assert.deepEqual(incus.log.filter(entry => !entry.startsWith('stop:')), ['kill:app-a']);
  assert.equal(incus.log.at(-1), 'kill:app-a', 'killed last, after every clean stop that was asked');
  assert.equal(incus.log.length, 13);
  assert.equal(incus.clock.t, 60_000, 'not killed at once');

  incus.addInstance('app-b', 'Running');
  incus.refused.add('app-b');
  const request = incus.incusRequest;
  const gone = loadSnapshot({ ...incus, incusRequest: async (method: string, url: string, body?: unknown) => {
    const response = await request(method, url, body);
    if (method === 'PUT') incus.instances.delete('app-b');
    return response;
  } });
  await assert.rejects(gone.stopContainerOrForce('app-b'), /could not be stopped: Instance is busy/);
  assert.deepEqual(incus.log.slice(13), ['stop:app-b:60'], 'never forced');
});

test("a stop that must succeed (the owner's stop) is clean first, then forced with a warning", async (t) => {
  const incus = fakeIncus();
  incus.addInstance('app-a', 'Running');
  incus.addInstance('app-b', 'Running');
  incus.stuck.add('app-b');
  const warnings: string[] = [];
  t.mock.method(console, 'warn', (message: string) => { warnings.push(message); });
  const snapshot = loadSnapshot(incus);
  await snapshot.stopContainerOrForce('app-a');
  await snapshot.stopContainerOrForce('app-b', { timeoutSec: 120 });
  assert.deepEqual(incus.log, ['stop:app-a:60', 'stop:app-b:120', 'kill:app-b']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /app-b did not stop cleanly within 120 s; forcing/);
});

test("the owner's stop and restart stop each container cleanly with its role's timeout before any forced stop", () => {
  const source = readFileSync(join(SRC, 'lib/apps/lifecycle.ts'), 'utf8');
  assert.doesNotMatch(source, /changeContainerState\(container\.name, 'stop'/);
  assert.match(source, /await stopContainerOrForce\(container\.name, \{ timeoutSec: stopTimeoutSec\(container\.role\) \}\)/);
  assert.equal(source.match(/await stopContainerCleanly\(container\)/g)?.length, 2);
});
