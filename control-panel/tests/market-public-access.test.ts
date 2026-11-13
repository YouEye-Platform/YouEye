import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installWantsPublicAccess } from '../src/lib/market/engine';
import { OFFICIAL_MARKET_SOURCE_ID } from '../src/lib/market/source';

test('install public access: an explicit choice wins, else only the official catalog default applies', () => {
  const declares = { publicAccess: true as const };
  const silent = {};
  const official = OFFICIAL_MARKET_SOURCE_ID;
  // Manifest default, official catalog only.
  assert.equal(installWantsPublicAccess(declares, { sourceId: official }), true);
  assert.equal(installWantsPublicAccess(declares, { sourceId: 'custom-repo' }), false);
  assert.equal(installWantsPublicAccess(declares, { sourceId: 'direct:abc' }), false);
  assert.equal(installWantsPublicAccess(declares, {}), false);
  assert.equal(installWantsPublicAccess(silent, { sourceId: official }), false);
  // The installing administrator's explicit choice.
  assert.equal(installWantsPublicAccess(declares, { sourceId: official, publicAccess: false }), false);
  assert.equal(installWantsPublicAccess(silent, { sourceId: 'direct:abc', publicAccess: true }), true);
});
