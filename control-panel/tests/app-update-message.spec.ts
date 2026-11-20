import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { completedMessage, resultFailureMessage } from '../src/lib/market/update-http';
import { loadSource } from './fixtures/update-provider-harness';

test('an update that had nothing to do says so instead of "Update complete"', () => {
  assert.equal(completedMessage({ unchanged: true, newVersion: '26.11.1' }), 'Already up to date (version 26.11.1): nothing was changed.');
  assert.equal(completedMessage({ unchanged: true }), 'Already up to date: nothing was changed.');
  assert.equal(completedMessage({ newVersion: '26.11.2' }), 'Update complete');
  assert.match(completedMessage({ sharedFolders: ['media'] }), /^Update complete\. Shared folders \(media\)/);
  // The updater marks both of its no-op returns, and only those.
  const updater = readFileSync(new URL('../src/lib/market/updater.ts', import.meta.url), 'utf8');
  assert.equal(updater.match(/is already up to date/g)?.length, 2);
  assert.equal(updater.match(/migrationsRun: 0, unchanged: true \}/g)?.length, 2);
});

test('a stop that timed out names its container and says nothing was changed, even though the operation was rolled back', () => {
  const operation = { id: 'op', rolledBack: true };
  const refused = 'Update not started: app-immich-postgres did not stop in time. Nothing was changed.';
  assert.equal(resultFailureMessage({ errorCode: 'writer-stop-timeout', error: refused, operationId: 'op' }, operation), refused);
  // Anything else in `error` is not shown.
  assert.equal(resultFailureMessage({ errorCode: 'writer-stop-timeout', error: 'Update recovery requires attention.', operationId: 'op' }, operation),
    'Update not started: a container of this app did not stop in time. Nothing was changed.');
  assert.match(resultFailureMessage({ errorCode: undefined, error: 'Health check failed', operationId: 'op' }, operation), /rolled back/);
  // Another operation's rollback is not this result's.
  assert.equal(resultFailureMessage({ errorCode: undefined, operationId: 'other' }, operation), 'Update failed. Check the operation status.');
  for (const code of ['postgres-runtime-change-excluded', 'sql-migration-own-database-unsupported', 'own-database-storage-undeclared']) {
    assert.match(resultFailureMessage({ errorCode: code }, null), /^Update not possible in place: .*Nothing was changed\.$/);
  }
  assert.match(resultFailureMessage({ errorCode: 'own-database-storage-undeclared' }, null), /own database does not keep its files in a declared volume/);
  const source = readFileSync(new URL('../src/lib/market/update-http.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /own-postgres-update-unsupported|own-postgres-storage-undeclared/);
});

test('a recovery that failed is never reported as "Nothing was changed"', () => {
  const refused = 'Update not started: app-immich-postgres did not stop in time. Nothing was changed.';
  const required = /^The update failed and the app could not be brought back: it stays in maintenance .*youeye app recover/;
  // The updater's own code for it.
  assert.match(resultFailureMessage({ errorCode: 'recovery_required', error: 'Update recovery requires attention.', operationId: 'op' }, null), required);
  // The record says so, whatever the first failure was: the stop timed out, then recovery could not start the app.
  for (const operation of [
    { id: 'op', rolledBack: false, committed: false, recoveryRequired: true },
    { id: 'op', rolledBack: false, committed: false, recoveryRequired: false }, // still recovering: not rolled back either
  ]) {
    assert.match(resultFailureMessage({ errorCode: 'writer-stop-timeout', error: refused, operationId: 'op' }, operation), required);
    assert.doesNotMatch(resultFailureMessage({ errorCode: 'writer-stop-timeout', error: refused, operationId: 'op' }, operation), /Nothing was changed/);
  }
  // A verified rollback of the refused update keeps the "nothing was changed" message.
  assert.equal(resultFailureMessage({ errorCode: 'writer-stop-timeout', error: refused, operationId: 'op' },
    { id: 'op', rolledBack: true, committed: false, recoveryRequired: false }), refused);

  // The updater reports the failed recovery's code, not the first failure's, when the rollback is not verified.
  const updater = readFileSync(new URL('../src/lib/market/updater.ts', import.meta.url), 'utf8');
  const failure = updater.slice(updater.indexOf('const recoveryFailed ='), updater.indexOf('await stagedNativeArtifacts.cleanup()'));
  assert.match(failure, /const recoveryFailed = !!record && !committed && !record\.rollbackVerifiedAt;/);
  assert.ok(failure.indexOf(": recoveryFailed ? 'recovery_required'") > 0
    && failure.indexOf(": recoveryFailed ? 'recovery_required'") < failure.indexOf("'code' in error"), 'before the error\'s own code');
});

/** The real update handler over a stubbed updater: `operation` is what the app's update record says once it returned. */
function updateHandler(result: Record<string, unknown>, operation: Record<string, unknown> | null) {
  let returned = false;
  const stubs: Record<string, unknown> = {
    'next/server': { NextResponse: { json: (body: unknown, init?: { status?: number }) => Response.json(body, init) } },
    '@/lib/auth/rbac': { requireAdmin: async () => ({}) },
    '@/lib/auth/session': { verifyCSRFToken: async () => true },
    '@/lib/market/installed-apps': { getInstalledApp: async () => ({ appId: 'immich' }) },
    '@/lib/market/updater': { updateMarketApp: async () => { returned = true; return result; } },
    // Nothing is pending before the update; afterwards the record is the update's own.
    '@/lib/market/update-operations': { getAppUpdateOperation: () => returned ? operation : null },
    '@/lib/market/update-admission': { withUserOperationLockWait: (work: () => unknown) => work() },
    '@/lib/market/install-tracker': { logOperationFailure() {} },
    '@/lib/http/lifecycle-busy': { isLifecycleBusy: () => false },
  };
  const http = loadSource('lib/market/update-http.ts', name => stubs[name] ?? {});
  const request = () => ({ headers: new Headers(), json: async () => ({ appId: 'immich' }) });
  return {
    json: async () => {
      returned = false;
      const answer = await http.handleMarketUpdate(request(), 'immich', 'json');
      return { status: answer.status, body: await answer.json() };
    },
    stream: async () => {
      returned = false;
      const text: string = await (await http.handleMarketUpdate(request())).text();
      return text.trim().split('\n\n').map(event => JSON.parse(event.slice(event.indexOf('data: ') + 6)));
    },
  };
}

test('the update API tells the owner that recovery is required: an uncommitted, unverified update is pending, and says so', async () => {
  const required = /^The update failed and the app could not be brought back: it stays in maintenance .*youeye app recover/;
  const failed = { success: false, errorCode: 'recovery_required', error: 'Update recovery requires attention.', operationId: 'op' };
  const error = console.error;
  console.error = () => {};
  try {
    for (const operation of [
      { id: 'op', pending: true, committed: false, rolledBack: false, recoveryRequired: true, reopened: false },
      { id: 'op', pending: true, committed: false, rolledBack: false, recoveryRequired: false, reopened: false }, // still recovering
    ]) {
      // Whatever failed first: here the updater's own code, and a stop timeout whose recovery then failed.
      for (const result of [failed, { ...failed, errorCode: 'writer-stop-timeout', error: 'Update not started: app-immich did not stop in time. Nothing was changed.' }]) {
        const handler = updateHandler(result, operation);
        const answer = await handler.json();
        assert.equal(answer.status, 409);
        assert.equal(answer.body.status, 'pending');
        assert.equal(answer.body.code, 'recovery_required');
        assert.match(answer.body.message, required);
        const events = await handler.stream();
        assert.equal(events.at(-1).stage, 'pending');
        assert.equal(events.at(-1).code, 'recovery_required');
        assert.match(events.at(-1).message, required);
      }
    }

    // The other pending states keep their own words.
    const pendingStates: Array<[Record<string, unknown>, RegExp]> = [
      // Rolled back, its recovery points not removed yet.
      [{ id: 'op', pending: true, committed: false, rolledBack: true, reopened: false }, /^Update pending\. Check its status or retry recovery \(youeye app recover immich\)\.$/],
      [{ id: 'op', pending: true, committed: true, rolledBack: false, reopened: false }, /^The new version is installed, but the app is still in maintenance/],
      [{ id: 'op', pending: true, committed: true, rolledBack: false, reopened: true }, /^The new version is installed and the app is open; removing/],
    ];
    for (const [operation, message] of pendingStates) {
      const handler = updateHandler({ ...failed, errorCode: 'committed-reopen-pending' }, operation);
      const answer = await handler.json();
      assert.deepEqual([answer.status, answer.body.status, answer.body.code], [409, 'pending', 'operation_pending']);
      assert.match(answer.body.message, message);
      const last = (await handler.stream()).at(-1);
      assert.equal(last.stage, 'pending');
      assert.equal(last.code, undefined);
      assert.match(last.message, message);
    }

    // A verified rollback with nothing left to do is a plain failure.
    const rolledBack = updateHandler({ success: false, error: 'Health check failed', operationId: 'op' },
      { id: 'op', pending: false, committed: false, rolledBack: true });
    const answer = await rolledBack.json();
    assert.equal(answer.status, 500);
    assert.match(answer.body.message, /rolled back/);
    assert.equal((await rolledBack.stream()).at(-1).stage, 'failed');
  } finally {
    console.error = error;
  }
});
