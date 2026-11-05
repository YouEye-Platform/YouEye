import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createTranslator} from 'next-intl';

// Exercise inflection boundaries instead of appending English suffixes in JSX.
for (const locale of ['en', 'ru', 'es', 'de', 'fr']) {
  test(`${locale} formats complete count messages across plural categories`, () => {
    const messages = JSON.parse(readFileSync(new URL(`../messages/${locale}.json`, import.meta.url)));
    const errors = [];
    const t = createTranslator({locale, messages, namespace: 'interface', onError: error => errors.push(error)});
    for (const count of [0, 1, 2, 5, 21]) {
      for (const key of ['loginAttemptsRemaining', 'peopleCount', 'containerCount', 'connectedMarkets', 'subscribedLists']) {
        const rendered = t(key, {count});
        assert.ok(rendered.includes(new Intl.NumberFormat(locale).format(count)), `${key} includes ${count}`);
        assert.doesNotMatch(rendered, /\{count|interface\./);
      }
    }
    if (locale === 'ru') {
      assert.equal(t('loginAttemptsRemaining', {count: 1}), 'Осталась 1 попытка');
      assert.equal(t('loginAttemptsRemaining', {count: 2}), 'Осталось 2 попытки');
      assert.equal(t('loginAttemptsRemaining', {count: 5}), 'Осталось 5 попыток');
      assert.equal(t('loginAttemptsRemaining', {count: 21}), 'Осталась 21 попытка');
    }
    assert.deepEqual(errors, []);
  });
}
