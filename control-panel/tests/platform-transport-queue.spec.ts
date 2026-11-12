import assert from 'node:assert/strict';
import test from 'node:test';
import { createPlatformDatabase } from '../src/lib/postgres/platform-transport';

const credentials = async () => ({ host: 'db.invalid', port: '5432', user: 'u', password: 'p', database: 'd' });

/** One fake connection with realistic per-command latency; tracks concurrency. */
function fakeDriver(latencyMs: number) {
  const stats = { connections: 0, concurrent: 0, maxConcurrent: 0, commands: 0 };
  const driver = () => {
    stats.connections++;
    return {
      unsafe: (command: string) => ({
        simple: () => ({
          raw: async () => {
            stats.commands++;
            stats.concurrent++;
            stats.maxConcurrent = Math.max(stats.maxConcurrent, stats.concurrent);
            await new Promise(resolve => setTimeout(resolve, latencyMs));
            stats.concurrent--;
            const row = [Buffer.from(command)];
            return Object.assign([row], { columns: [] });
          },
        }),
      }),
      end: async () => undefined,
    };
  };
  return { stats, driver: driver as never };
}

test('a burst of 200 concurrent commands queues on the one connection and all succeed', async () => {
  const { stats, driver } = fakeDriver(2);
  const database = createPlatformDatabase(credentials, { driver });
  const results = await Promise.all(Array.from({ length: 200 }, (_, i) => database.command(`SELECT ${i}`)));
  assert.deepEqual(results, Array.from({ length: 200 }, (_, i) => `SELECT ${i}`));
  assert.equal(stats.connections, 1);
  assert.equal(stats.maxConcurrent, 1, 'commands stay serialised on one connection');
});

test('a caller that cannot get the connection in time fails with a clear error', async () => {
  const { driver } = fakeDriver(300);
  const database = createPlatformDatabase(credentials, { driver, waitTimeoutMs: 100 });
  const first = database.command('SELECT slow');
  await assert.rejects(database.command('SELECT queued'), /Platform database wait timed out after 0\.1 s/);
  assert.equal(await first, 'SELECT slow');
  assert.equal(await database.command('SELECT after'), 'SELECT after');
});

test('the queue bound still refuses an unbounded backlog', async () => {
  const { driver } = fakeDriver(50);
  const database = createPlatformDatabase(credentials, { driver, maxQueue: 2 });
  const accepted = [database.command('a'), database.command('b'), database.command('c')];
  await assert.rejects(database.command('d'), /Platform database is busy \(2 commands already queued\)/);
  assert.deepEqual(await Promise.all(accepted), ['a', 'b', 'c']);
});
