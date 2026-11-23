/**
 * YE-42: a fresh box logged "app-update journals could not be inspected; platform reconciliation remains stopped"
 * twice before setup. The Control Panel starts during the first deploy, before PostgreSQL exists; reading the journal
 * succeeded, but closing the damaged-receipt alarm in the health registry (PostgreSQL) threw, and the start stopped
 * before the maintenance loops, the app reconciler and the health monitor.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { load, root } from './fixtures/market-world';

function operations(state: { records?: any[]; damaged?: any[]; resolve: () => Promise<void> }) {
  const observed: string[] = [];
  const module = load('src/lib/market/update-operations.ts', {
    './install-tracker': { logOperationFailure: () => {} },
    './update-admission': {
      appUpdateJournalStore: () => ({ scan: () => ({ records: state.records ?? [], damaged: state.damaged ?? [] }), prune: () => false }),
      withAppLifecycle: () => { throw new Error('no recovery expected'); },
    },
    './update-transaction': {}, './update-provider': {}, '../pointer/release-metadata': {}, './update-release-metadata': {},
    '@/lib/health/issues': {
      resolveIssue: async () => state.resolve(),
      observeIssue: async (issue: { id: string }) => {
        await state.resolve();
        observed.push(issue.id);
      },
    },
  });
  return { reconcile: () => module.reconcileAppUpdateOperations() as Promise<void>, observed };
}

const noDatabase = async () => { throw new Error('psql: connection to server on socket failed: youeye-postgres does not exist'); };

test('an empty journal is inspected on a box without PostgreSQL yet (before the first deploy finishes)', async () => {
  const warnings: unknown[][] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  try {
    await operations({ resolve: noDatabase }).reconcile();
  } finally {
    console.warn = warn;
  }
  assert.equal(warnings.length, 1);
  assert.match(String(warnings[0][0]), /health registry can't be read yet.*youeye-postgres does not exist/);
});

test('with the registry up the alarm is closed, and nothing is logged', async () => {
  let resolved = 0;
  await operations({ resolve: async () => { resolved++; } }).reconcile();
  assert.equal(resolved, 1);
});

test('a damaged receipt still fails closed without the registry: its alarm can not be recorded, so the start stops', async () => {
  // Naming an app: the alarm (which refuses that app's updates) must be recorded, so a missing registry fails the start.
  await assert.rejects(operations({ damaged: [{ file: 'wiki_x.json', appId: 'wiki' }], resolve: noDatabase }).reconcile(),
    /youeye-postgres does not exist/);
  // Naming no app: refused whatever the registry does.
  await assert.rejects(operations({ damaged: [{ file: 'x.json' }], resolve: async () => {} }).reconcile(),
    /names no app is damaged/);
});

test('the start logs why the journal could not be inspected', () => {
  const instrumentation = readFileSync(join(root, 'src/instrumentation.ts'), 'utf8');
  assert.match(instrumentation, /\} catch \(error\) \{\n\s+console\.error\("\[instrumentation\] app-update journals could not be inspected; platform reconciliation remains stopped:", error\);\n\s+return;/);
});
