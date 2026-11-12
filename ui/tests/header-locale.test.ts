import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePreferredLocale } from '../src/i18n/config';

test('personal locale wins; missing or invalid preferences fall back safely', () => {
  assert.equal(resolvePreferredLocale('ru', 'de'), 'ru');
  assert.equal(resolvePreferredLocale(null, 'de'), 'de');
  assert.equal(resolvePreferredLocale('', 'es'), 'es');
  assert.equal(resolvePreferredLocale('../private', 'fr'), 'fr');
  assert.equal(resolvePreferredLocale({ language: 'ru' }, ['de']), 'en');
  assert.equal(resolvePreferredLocale(undefined, undefined), 'en');
});

test('alternating users and changed preferences never reuse another user locale', () => {
  const preferences = ['ru', 'fr', null, 'de', 'ru', undefined];
  assert.deepEqual(preferences.map(value => resolvePreferredLocale(value, 'es')),
    ['ru', 'fr', 'es', 'de', 'ru', 'es']);
});
