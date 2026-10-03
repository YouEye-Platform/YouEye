import assert from 'node:assert/strict';
import test from 'node:test';
import { repairRouteForCurrentDomain } from '../src/lib/reconfigure/route-repair';

test('background route repair cannot recreate the old app host during migration or from a stale snapshot', async () => {
  let pending = true;
  let domain = 'old.test';
  const routes: string[] = [];
  const operations = {
    pending: async () => pending,
    domain: async () => domain,
    repair: async () => { routes.push('old.test'); },
  };
  assert.equal(await repairRouteForCurrentDomain('old.test', operations), false);
  pending = false;
  domain = 'new.test';
  assert.equal(await repairRouteForCurrentDomain('old.test', operations), false);
  assert.deepEqual(routes, []);
  assert.equal(await repairRouteForCurrentDomain('new.test', { ...operations, repair: async () => { routes.push('new.test'); } }), true);
  assert.deepEqual(routes, ['new.test']);
});

test('migration starting while current domain is read suppresses the route write', async () => {
  let pending = false;
  assert.equal(await repairRouteForCurrentDomain('old.test', {
    pending: async () => pending,
    domain: async () => { pending = true; return 'old.test'; },
    repair: async () => { assert.fail('old route must not be written'); },
  }), false);
});
