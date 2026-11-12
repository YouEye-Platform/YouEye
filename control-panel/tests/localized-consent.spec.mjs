import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {createTranslator} from 'next-intl';
const source = readFileSync(new URL('../src/app/application/o/authorize/route.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('route.ts', source, ts.ScriptTarget.Latest, true);
const declaration = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'consentHtml');
const code = ts.transpileModule(declaration.getText(ast) + '\nexports.render = consentHtml;', {
  compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true}
}).outputText;
const catalogue = locale => JSON.parse(readFileSync(new URL(`../messages/${locale}.json`, import.meta.url)));
const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const api = {};
runInNewContext(code, {
  exports: api, Response, createTranslator, english: catalogue('en'),
  mergeMessages: (a,b) => ({interface: {...a.interface, ...b.interface}}),
  settingsService: {getRaw: async () => ({language: 'de'})},
  resolvePreferredLocale: (user, system) => ['en','ru','es','de','fr'].includes(user) ? user : system,
  localeDirection: () => 'ltr', escapeHtml,
  scopeList: s => s.split(' '), absoluteAssetUrl: () => null,
  appBrand: () => '', identityFaviconLinks: () => '', accountAvatar: () => '',
  require: id => catalogue(id.match(/\/([a-z]{2})\.json$/)[1]),
});

test('actual consent HTML translates per trusted user and escapes identity, permissions and query', async () => {
  for (const [locale, button] of [['ru','Продолжить'],['es','Continuar'],['de','Weiter'],['fr','Continuer'],['en','Continue']]) {
    const response = await api.render({
      client: {name: '<script>app</script>', client_id: 'test'},
      user: {name: '<img src=x>', username:'tester', email: 'tester@example.test'},
      scope: 'profile email', query: '"><script>query</script>', providerName:'YouEye',
      display: {locale}, runtimePermissions: [{permission:'custom:"<test>', title:'<script>grant</script>', description:'<b>raw</b>'}],
    });
    const html = await response.text();
    assert.ok(html.includes(`lang="${locale}"`));
    assert.ok(html.includes(button), locale);
    assert.ok(html.includes('&lt;script&gt;app&lt;/script&gt;'));
    assert.ok(html.includes('&lt;script&gt;grant&lt;/script&gt;'));
    assert.ok(!html.includes('<script>'));
    assert.ok(html.includes('name="decision" value="approve"'));
    assert.ok(html.includes('name="decision" value="deny"'));
    assert.ok(!html.includes('MISSING_MESSAGE'));
  }
});
