import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

test('admission logout uses the durable revocation time and deduplicates each revision separately', async () => {
  let revision = 2;
  const calls: unknown[][] = [];
  const deliveries: Array<{ eventKey: string; token: string }> = [];
  const exports: { reconcileAdmissionLogouts?: () => Promise<void> } = {};
  const code = ts.transpileModule(readFileSync(
    new URL('../src/lib/admission/logout.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(code, {
    exports, Number,
    require: (name: string) => {
      if (name === '@/lib/identity/store') return {
        ensureIdentitySchema: async () => {},
        identitySql: (value: unknown) => String(value),
        identityRows: async (sql: string) => {
          if (sql.includes('SELECT')) {
            assert.match(sql, /cutoff\.revoked_before/);
            return [{ client_id: 'app-a', user_id: 'user', session_id: 'sid',
              revision, uri: 'https://a.example.test/logout', issued_at: '100' }];
          }
          assert.match(sql, new RegExp(`revision = ${revision}`));
          return [];
        },
        enqueueLogoutDelivery: async (delivery: { eventKey: string; token: string }) => deliveries.push(delivery),
      };
      if (name === '@/lib/identity/tokens') return {
        createLogoutToken: async (...args: unknown[]) => { calls.push(args); return `signed:${args[3]}`; },
      };
      throw new Error(`Unexpected dependency ${name}`);
    },
  });
  await exports.reconcileAdmissionLogouts!();
  revision++;
  await exports.reconcileAdmissionLogouts!();
  assert.deepEqual(calls.map(args => Array.from(args)), [
    ['app-a', 'user', 'sid', 100], ['app-a', 'user', 'sid', 100],
  ]);
  assert.deepEqual(deliveries.map(d => d.eventKey), [
    'admission:app-a:user:sid:2', 'admission:app-a:user:sid:3',
  ]);
});
