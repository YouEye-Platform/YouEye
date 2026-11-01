import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function harness(pathname = '/settings/ai') {
  const source = readFileSync(new URL('../src/components/locale-refresh.tsx', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX}}).outputText;
  const events = new Map(), requests = [];
  let effect, cleanup, refreshes = 0, reply = {ok: true, json: async () => ({locale: 'ru'})};
  const eventTarget = {addEventListener: (type, fn) => events.set(type, fn), removeEventListener: type => events.delete(type)};
  const context = {
    exports: {}, document: {...eventTarget, visibilityState: 'visible'}, window: eventTarget,
    BroadcastChannel: class {addEventListener(type, fn) {events.set(type, fn);} close() {events.delete('message');}},
    fetch: async (...args) => {requests.push(args); if (reply instanceof Error) throw reply; return reply;},
    require: name => {
      if (name === 'react') return {useEffect: fn => {effect = fn;}};
      if (name === 'next/navigation') return {usePathname: () => pathname, useRouter: () => ({refresh: () => refreshes++})};
      if (name === './settings-shell/api-base') return {uiSettingsApi: path => '/settings/api/ui-settings/' + path};
      throw new Error('Unexpected import ' + name);
    },
  };
  vm.runInNewContext(code, context);
  context.exports.LocaleRefresh({locale: 'ru'}); cleanup = effect();
  return {events, requests, context, cleanup, setReply: value => {reply = value;}, get refreshes() {return refreshes;}};
}

test('Settings only trusts its authenticated response, preserves same-locale/offline/denied views', async () => {
  const h = harness();
  await h.events.get('message')({data: {locale: 'fr'}});
  assert.equal(h.refreshes, 0, 'event data cannot select French');
  assert.equal(h.requests[0][0], '/settings/api/ui-settings/language');
  assert.equal(h.requests[0][1].cache, 'no-store');
  h.setReply({ok: false}); await h.events.get('focus')(); assert.equal(h.refreshes, 0);
  h.setReply(new Error('offline')); await h.events.get('focus')(); assert.equal(h.refreshes, 0);
  h.setReply({ok: true, json: async () => ({locale: 'fr'})});
  await h.events.get('visibilitychange')(); assert.equal(h.refreshes, 1);
  h.cleanup(); assert.equal(h.events.size, 0);
});

test('Market uses its own namespace and ignores a read completing after unmount', async () => {
  const h = harness('/market/sources');
  let resolve;
  h.setReply({ok: true, json: () => new Promise(done => {resolve = done;})});
  const pending = h.events.get('focus')();
  await Promise.resolve();
  await h.events.get('visibilitychange')();
  assert.equal(h.requests.length, 1, 'overlapping signals share one in-flight check');
  assert.equal(h.requests[0][0], '/market/api/ui-settings/language');
  h.cleanup(); resolve({locale: 'de'}); await pending;
  assert.equal(h.refreshes, 0);
});
