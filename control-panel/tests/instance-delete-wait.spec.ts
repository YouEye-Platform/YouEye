/**
 * YE-222: an uninstall reported "Instance app-sonarr remains after delete" and left the app's volumes, because the
 * delete operation's own result was never read: Incus's `operation/wait` answers with an ordinary envelope whether the
 * operation succeeded, failed or still runs. deleteOwnedInstance now decides from `metadata.status`, retries a failed
 * attempt and gives a finished delete a moment to read back absent, all bounded.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const root = process.env.CONTROL_PANEL_ROOT || path.join(import.meta.dirname, '..');
const INSTALLATION = '20000000-0000-4000-8000-000000000001';
const tags = { 'user.youeye.app_id': 'sonarr', 'user.youeye.installation_id': INSTALLATION };
const owner = { appId: 'sonarr', installationId: INSTALLATION };

type Step = { status: 'Success' | 'Failure' | 'Running'; err?: string; removes?: boolean; readsBack?: number };

/**
 * A fake Incus holding app-sonarr. Each DELETE takes the next scripted step: its wait answers with `status` (a
 * Running step answers Running once, then Success), and a successful delete removes the instance after `readsBack`
 * more reads (a delete that takes a moment to read back absent).
 */
function incus(steps: Step[], waitErrors = 0) {
  let present = true;
  let readsLeft = Infinity;
  const log: string[] = [];
  let current: Step | undefined;
  let runningOnce = false;
  const incusRequest = async (method: string, route: string) => {
    if (method === 'GET' && route.startsWith('/1.0/instances/')) {
      if (present && readsLeft !== Infinity && readsLeft-- <= 0) present = false;
      if (!present) return { type: 'error', error_code: 404, error: 'not found' };
      return { type: 'sync', metadata: { name: 'app-sonarr', config: tags } };
    }
    if (method === 'PUT') { log.push('stop'); return { type: 'sync' }; }
    if (method === 'DELETE') {
      current = steps.shift() ?? { status: 'Success' };
      runningOnce = current.status === 'Running';
      log.push(`delete ${current.status}`);
      return { type: 'async', operation: '/1.0/operations/op-1' };
    }
    if (method === 'GET' && route === '/1.0/operations/op-1') {
      log.push('read operation');
      return { type: 'sync', metadata: { status: 'Running' } };
    }
    if (method === 'GET' && route.includes('/wait') && waitErrors > 0) {
      waitErrors--;
      log.push('wait error');
      return { type: 'error', error: 'timeout' };
    }
    if (method === 'GET' && route.includes('/wait')) {
      const step = current!;
      if (runningOnce) { runningOnce = false; log.push('wait Running'); return { type: 'sync', metadata: { status: 'Running' } }; }
      const status = step.status === 'Running' ? 'Success' : step.status;
      log.push(`wait ${status}`);
      if (status === 'Success' && step.removes !== false) readsLeft = step.readsBack ?? 0;
      return { type: 'sync', metadata: { status, err: step.err } };
    }
    throw new Error(`unexpected ${method} ${route}`);
  };
  return { incusRequest, log, present: () => present };
}

function ownership(incusRequest: unknown) {
  const exports: Record<string, any> = {};
  const warnings: string[] = [];
  vm.runInNewContext(ts.transpileModule(readFileSync(path.join(root, 'src/lib/market/instance-ownership.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText, {
    exports, module: { exports }, setTimeout: (run: () => void) => setImmediate(run), Date,
    console: { ...console, warn: (line: string) => warnings.push(line) },
    require: (name: string) => {
      if (name === '../incus/server') return { incusRequest };
      return {};
    },
  });
  return { api: exports, warnings };
}

test('a delete that still runs after the first wait is waited for, not read back early (YE-222)', async () => {
  const fake = incus([{ status: 'Running' }]);
  const { api } = ownership(fake.incusRequest);
  assert.equal(await api.deleteOwnedInstance('app-sonarr', owner), 'deleted');
  assert.deepEqual(fake.log, ['stop', 'delete Running', 'wait Running', 'wait Success']);
});

test('a finished delete that reads back present for a moment is given time to go (YE-222)', async () => {
  const fake = incus([{ status: 'Success', readsBack: 3 }]);
  const { api } = ownership(fake.incusRequest);
  assert.equal(await api.deleteOwnedInstance('app-sonarr', owner), 'deleted');
  assert.deepEqual(fake.log, ['stop', 'delete Success', 'wait Success'], 'one delete; the read-back waited');
});

test('a failed delete is read as failed and tried again; the second attempt deletes (YE-222)', async () => {
  const fake = incus([{ status: 'Failure', err: 'Failed to retrieve PID of executing child process' }, { status: 'Success' }]);
  const { api, warnings } = ownership(fake.incusRequest);
  assert.equal(await api.deleteOwnedInstance('app-sonarr', owner), 'deleted');
  assert.deepEqual(fake.log, ['stop', 'delete Failure', 'wait Failure', 'delete Success', 'wait Success']);
  assert.match(warnings.join('\n'), /not confirmed \(attempt 1\): Deleting app-sonarr failed: Failed to retrieve PID/);
});

test('a delete that keeps failing ends with its error after the bounded attempts, and the instance stays (YE-222)', async () => {
  const failure = { status: 'Failure' as const, err: 'instance busy' };
  const fake = incus([failure, failure, failure, failure]);
  const { api } = ownership(fake.incusRequest);
  api.INSTANCE_DELETE_LIMITS.retryMs = 0;
  await assert.rejects(api.deleteOwnedInstance('app-sonarr', owner), /Deleting app-sonarr failed: instance busy/);
  assert.equal(fake.log.filter((line) => line.startsWith('delete')).length, 3, 'three attempts, no more');
  assert.equal(fake.present(), true);
});

test('a delete that never reads back absent ends as "remains after delete", bounded (YE-222)', async () => {
  const fake = incus([{ status: 'Success', removes: false }, { status: 'Success', removes: false }, { status: 'Success', removes: false }]);
  const { api } = ownership(fake.incusRequest);
  Object.assign(api.INSTANCE_DELETE_LIMITS, { retryMs: 0, settleMs: 0, pollMs: 0 });
  await assert.rejects(api.deleteOwnedInstance('app-sonarr', owner), /Instance app-sonarr remains after delete/);
});

test('the uninstall and the forced cleanup delete data and secrets only once every container is gone (YE-222)', () => {
  const uninstaller = readFileSync(path.join(root, 'src/lib/market/uninstaller.ts'), 'utf8');
  assert.match(uninstaller, /containersGone = false;\s*errors\.push\(cleanupFailure\(appId, `Container/);
  assert.match(uninstaller, /if \(!containersGone\) throw new Error\('its data is kept until its containers are gone[^']*'\);\s*await deleteAppStorage/);
  // Secrets only after the data is gone: kept data never meets new secrets.
  assert.ok(uninstaller.indexOf('await deleteAllAppSecrets(appId);') > uninstaller.indexOf('await deleteAppStorage(metadata.storageVolumes'));
  const reconciler = readFileSync(path.join(root, 'src/lib/market/reconciler.ts'), 'utf8');
  assert.match(reconciler, /if \(!instancesGone\) throw new Error\('its data is kept until its instances are gone'\)/);
  assert.ok(reconciler.indexOf('await deleteAllAppSecrets(appId);') > reconciler.indexOf('if (own.length) await deleteAppStorage(own);'));
});

test('a wait that answers with an error while the delete still runs reads the operation, never deletes twice (YE-222 review)', async () => {
  const fake = incus([{ status: 'Success' }], 1);
  const { api } = ownership(fake.incusRequest);
  assert.equal(await api.deleteOwnedInstance('app-sonarr', owner), 'deleted');
  assert.deepEqual(fake.log, ['stop', 'delete Success', 'wait error', 'read operation', 'wait Success']);
});

test('a delete still running after every wait is not sent again: the attempt ends unconfirmed, the instance kept (Iris, batch 1)', async () => {
  // A step that answers Running on every wait: the fake's Running answers once, so script a long-running one.
  const fake = incus([{ status: 'Running' }]);
  const always = async (method: string, route: string) => {
    if (method === 'GET' && route.includes('/wait')) { fake.log.push('wait Running'); return { type: 'sync', metadata: { status: 'Running' } }; }
    return fake.incusRequest(method, route);
  };
  const { api } = ownership(always);
  Object.assign(api.INSTANCE_DELETE_LIMITS, { retryMs: 0 });
  await assert.rejects(api.deleteOwnedInstance('app-sonarr', owner), /Deleting app-sonarr did not finish in time/);
  assert.equal(fake.log.filter((line) => line.startsWith('delete')).length, 1, 'one DELETE only');
  assert.equal(fake.log.filter((line) => line === 'wait Running').length, 3, 'the bounded waits');
  assert.equal(fake.present(), true);
});
