import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { createRequire } from 'node:module';

const nativeRequire = createRequire(import.meta.url);
const modules = new Map();
function loadTypeScript(url) {
  if (modules.has(url.href)) return modules.get(url.href);
  const exports = {};
  modules.set(url.href, exports);
  const code = ts.transpileModule(readFileSync(url, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(code, { exports, Buffer, Response, require: name => name.startsWith('.')
    ? loadTypeScript(new URL(name + '.ts', url)) : nativeRequire(name) });
  return exports;
}

function notifications({ session = null, serviceUser = null, permission = false, bridge = false } = {}) {
  const calls = [];
  const mocks = {
    'next/server': { NextResponse: { json: (body, init) => Response.json(body, init) } },
    '@/lib/auth': { getSession: async () => session },
    '@/lib/auth/service': { resolveServiceAuth: async () => serviceUser },
    '@/lib/admin/bridge-client': { getBridgeToken: () => bridge ? 'test-bridge' : null },
    '@/lib/auth/app-credential-readiness': loadTypeScript(new URL('../src/lib/auth/app-credential-readiness.ts', import.meta.url)),
    '@/lib/db/queries/permissions': {
      checkPermission: async (...args) => { calls.push(['permission', ...args]); return permission; },
    },
    '@/lib/db/queries/notifications': {
      getUserNotifications: async id => { calls.push(['read', id]); return []; },
      getUnreadCount: async () => 0,
      getNotificationCount: async () => 0,
      createNotification: async data => { calls.push(['create', data]); return data; },
      markAllNotificationsRead: async id => { calls.push(['mark', id]); },
      deleteReadNotifications: async id => { calls.push(['delete', id]); },
    },
    '@/lib/db/queries/app-management': {
      getNotificationSurfaceMap: async () => ({}),
      getAppMetaMap: async () => ({}),
    },
    '@/lib/rate-limit': {
      checkRateLimit: () => ({ allowed: true }),
      RATE_LIMITS: { notifications: {} },
    },
  };
  const code = ts.transpileModule(
    readFileSync(new URL('../src/app/api/v1/notifications/route.ts', import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const exports = {};
  vm.runInNewContext(code, {
    exports, URL, Response,
    require: name => {
      if (!(name in mocks)) throw new Error(`Unexpected dependency: ${name}`);
      return mocks[name];
    },
  });
  return { handlers: exports, calls };
}

const request = (method = 'GET', body, headers = {}, machine = true) => new Request('https://ui.example/api/v1/notifications', {
  method, headers: { ...(machine ? { 'X-YouEye-App': 'wiki', 'X-YouEye-User': 'victim' } : {}), ...headers },
  ...(body ? { body: JSON.stringify(body) } : {}),
});

test('admitted app credentials cannot read, mark or delete another app’s inbox messages', async () => {
  const { handlers, calls } = notifications({ serviceUser: { id: 'acting-user' }, permission: true });
  for (const method of ['GET', 'PUT', 'DELETE']) {
    assert.equal((await handlers[method](request(method))).status, 401);
  }
  assert.deepEqual(calls, []);
});

test('inbox queries derive the authenticated browser user', async () => {
  const { handlers, calls } = notifications({ session: { userId: 'browser-user' } });
  for (const method of ['GET', 'PUT', 'DELETE']) {
    assert.equal((await handlers[method](request(method, undefined, {}, false))).status, 200);
  }
  assert.deepEqual(calls, [['read', 'browser-user'], ['mark', 'browser-user'], ['delete', 'browser-user']]);
});

test('service sending requires runtime permission and cannot nominate another recipient', async () => {
  const user = { id: 'acting-user' };
  const denied = notifications({ serviceUser: user });
  assert.equal((await denied.handlers.POST(request('POST', { title: 'Test' }))).status, 403);
  assert.deepEqual(denied.calls, [['permission', 'acting-user', 'wiki', 'notifications:send']]);
  const allowed = notifications({ serviceUser: user, permission: true });
  assert.equal((await allowed.handlers.POST(request('POST', { title: 'Test', user_id: 'victim' }))).status, 403);
  assert.ok(!allowed.calls.some(([action]) => action === 'create'));
  assert.equal((await allowed.handlers.POST(request('POST', { title: 'Test' }))).status, 201);
  assert.equal(allowed.calls.find(([action]) => action === 'create')[1].userId, 'acting-user');
});

test('authenticated platform bridge still sends system notifications to its explicit recipient', async () => {
  const { handlers, calls } = notifications({ bridge: true });
  assert.equal((await handlers.POST(request('POST', { title: 'System', user_id: 'recipient' },
    { 'X-UI-Bridge-Token': 'test-bridge' }, false))).status, 201);
  assert.equal(calls[0][1].userId, 'recipient');
});

test('mixed bridge and app credentials cannot use an administrator browser session', async () => {
  const { handlers, calls } = notifications({ bridge: true, session: { userId: 'admin' } });
  assert.equal((await handlers.POST(request('POST', { title: 'System', user_id: 'victim' },
    { 'X-UI-Bridge-Token': 'test-bridge' }))).status, 401);
  assert.deepEqual(calls, []);
});
