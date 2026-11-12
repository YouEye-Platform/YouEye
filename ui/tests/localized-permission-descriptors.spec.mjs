import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {createTranslator} from 'next-intl';
const english = JSON.parse(readFileSync(new URL('../messages/en.json', import.meta.url)));
const source = ts.transpileModule(readFileSync(new URL('../src/lib/permissions/descriptors.ts', import.meta.url), 'utf8'), {
  compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true}
}).outputText;
const api = {};
runInNewContext(source, {exports: api, require(id) {
  if (id === 'next-intl') return {createTranslator};
  if (id.endsWith('/en.json')) return english;
  throw new Error(id);
}});

test('descriptors translate per caller while preserving permission decisions and external identifiers', () => {
  const seen = new Set();
  for (const locale of ['en', 'ru', 'es', 'de', 'fr']) {
    const messages = JSON.parse(readFileSync(new URL(`../messages/${locale}.json`, import.meta.url)));
    const t = createTranslator({locale, messages, namespace: 'interface'});
    const descriptor = api.describePermission('timeline:write', t);
    seen.add(descriptor.description);
    assert.equal(descriptor.permission, 'timeline:write');
    assert.equal(descriptor.category, 'timeline');
    assert.equal(descriptor.risk, 'medium');
    const internet = api.describePermission('internet:example.test', t);
    assert.ok(internet.title.includes('example.test'));
    assert.equal(internet.permission, 'internet:example.test');
    assert.ok(!internet.title.includes('MISSING_MESSAGE'));
    const unknown = api.describePermission('custom:scope', t);
    assert.equal(unknown.permission, 'custom:scope');
    assert.equal(unknown.risk, 'medium');
  }
  assert.equal(seen.size, 5);
  // A later English caller cannot inherit the previous caller's locale.
  const englishT = createTranslator({locale: 'en', messages: english, namespace: 'interface'});
  assert.equal(api.describePermission('timeline:write').description, api.describePermission('timeline:write', englishT).description);
  assert.ok(seen.has(api.describePermission('timeline:write').description));
});
