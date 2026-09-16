import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  probeLXDServiceHTTP,
  reconcilePostgresCredential,
  repairThenVerify,
  waitForPostgres,
} from '../src/lib/infrastructure/health-checks';

test('existing healthy infrastructure is verified without repair', async () => {
  let repairs = 0;
  const result = await repairThenVerify(
    'PostgreSQL',
    async () => true,
    async () => { repairs += 1; },
  );
  assert.equal(result, 'healthy');
  assert.equal(repairs, 0);
});

test('existing unhealthy infrastructure is repaired and re-probed', async () => {
  const stages: string[] = [];
  let repaired = false;
  const result = await repairThenVerify(
    'Pi-Hole',
    async (stage) => {
      stages.push(stage);
      return repaired;
    },
    async () => { repaired = true; },
  );
  assert.equal(result, 'repaired');
  assert.deepEqual(stages, ['initial', 'after-repair']);
});

test('reconciliation fails truthfully when repair does not restore health', async () => {
  await assert.rejects(
    repairThenVerify('PostgreSQL', async () => false, async () => {}),
    /PostgreSQL remained unhealthy after reconciliation repair/,
  );
});

test('PostgreSQL health proves the persisted credential over TCP', async () => {
  const calls: Array<{ command: string[]; environment?: Record<string, string> }> = [];
  const execute = async (
    _container: string,
    command: string[],
    options?: { environment?: Record<string, string> },
  ) => {
    calls.push({ command, environment: options?.environment });
    return { exitCode: 0, stdout: '1\n', stderr: '' };
  };

  assert.equal(await waitForPostgres('test-password', 'postgres', 100, execute), true);
  assert.deepEqual(calls[0]?.command.slice(0, 5), [
    '/usr/local/bin/psql', '-h', '127.0.0.1', '-U', 'youeye',
  ]);
  assert.equal(calls[0]?.environment?.PGPASSWORD, 'test-password');
});

test('PostgreSQL role repair keeps the credential out of command arguments', async () => {
  const calls: Array<{ command: string[]; environment?: Record<string, string> }> = [];
  const execute = async (
    _container: string,
    command: string[],
    options?: { environment?: Record<string, string> },
  ) => {
    calls.push({ command, environment: options?.environment });
    return { exitCode: 0, stdout: '', stderr: '' };
  };

  await reconcilePostgresCredential('test-password', 'postgres', 100, execute);
  const call = calls[0];
  assert.ok(call);
  assert.doesNotMatch(call.command.join(' '), /test-password/);
  assert.match(call.command.at(-1) ?? '', /current_setting\('youeye\.bootstrap_password'\)/);
  assert.equal(call.environment?.PGOPTIONS, '-c youeye.bootstrap_password=dGVzdC1wYXNzd29yZA==');
});

test('LXD application health requires an active service and successful HTTP probe', async () => {
  const calls: string[][] = [];
  const healthyExec = async (_container: string, command: string[]) => {
    calls.push(command);
    return command[0] === '/usr/bin/systemctl'
      ? { exitCode: 0, stdout: 'active\n', stderr: '' }
      : { exitCode: 0, stdout: '{"status":"ok"}\n', stderr: '' };
  };

  assert.equal(
    await probeLXDServiceHTTP('youeye-ui', 'youeye-ui', 3000, '/api/health', healthyExec),
    true,
  );
  assert.deepEqual(calls[0], ['/usr/bin/systemctl', 'is-active', 'youeye-ui.service']);
  assert.equal(calls[1].at(-1), 'http://127.0.0.1:3000/api/health');

  const inactiveExec = async () => ({ exitCode: 3, stdout: 'inactive\n', stderr: '' });
  assert.equal(
    await probeLXDServiceHTTP('youeye-ui', 'youeye-ui', 3000, '/api/health', inactiveExec),
    false,
  );

  const badHTTPExec = async (_container: string, command: string[]) => command[0] === '/usr/bin/systemctl'
    ? { exitCode: 0, stdout: 'active\n', stderr: '' }
    : { exitCode: 22, stdout: '', stderr: 'HTTP 503' };
  assert.equal(
    await probeLXDServiceHTTP('youeye-ui', 'youeye-ui', 3000, '/api/health', badHTTPExec),
    false,
  );
});

test('LXD repair awaits stop and delete before the idempotent deploy check', () => {
  const source = readFileSync(
    new URL('../src/lib/infrastructure/lxd-deployer.ts', import.meta.url),
    'utf8',
  );
  const repair = source.slice(
    source.indexOf('export async function redeployLXDContainer'),
    source.indexOf('/** Wait for an async Incus operation.'),
  );

  const stopWait = repair.indexOf('await waitForLXDOperation(stopped.operation, 60)');
  const deleteRequest = repair.indexOf("'DELETE'");
  const deleteWait = repair.indexOf('await waitForLXDOperation(deleted.operation, 60)');
  const redeploy = repair.lastIndexOf('return deployLXDContainer');

  assert.ok(stopWait >= 0 && stopWait < deleteRequest);
  assert.ok(deleteRequest < deleteWait && deleteWait < redeploy);
  assert.match(repair, /instance still exists after delete operation/);
});
