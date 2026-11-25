// The published Market format (src/lib/market/market-format.ts): what this reader accepts from an index.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MARKET_APP_KINDS, isKnownAppKind, readMarketIndex, requiredYouEye } from '../src/lib/market/market-format';

const bundle = (id: string) => ({ path: `h/apps/${id}/${'c'.repeat(64)}.json`, sha256: 'c'.repeat(64), size: 100 });

test('native is an app kind this reader installs, next to container (YE-142)', () => {
  assert.deepEqual([...MARKET_APP_KINDS], ['container', 'native']);
  assert.equal(isKnownAppKind('native'), true);
  assert.equal(isKnownAppKind('container'), true);
  assert.equal(isKnownAppKind('wasm'), false);
});

test('a native entry is an ordinary index entry with its requirement; an unknown kind still parses', () => {
  const index = readMarketIndex(JSON.stringify({
    schema: 'youeye.market-index.v1',
    apps: [
      { id: 'notes', kind: 'native', name: 'Notes', version: '0.6.4', requires: { youeye: '>=0.6.20' }, bundle: bundle('notes') },
      { id: 'later', kind: 'wasm', name: 'Later' },
      { id: 'alpha', kind: 'container', name: 'Alpha', bundle: bundle('alpha') },
    ],
  }));
  assert.deepEqual(index.apps.map((entry) => [entry.id, entry.kind]), [['notes', 'native'], ['later', 'wasm'], ['alpha', 'container']]);
  assert.equal(requiredYouEye(index.apps[0]), '0.6.20');
  assert.deepEqual(index.warnings, []);
});
