import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const root = process.env.CONTROL_PANEL_ROOT || join(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const id = '12345678-1234-4234-8234-123456789abc';
const otherId = '12345678-1234-4234-8234-123456789abd';

// Match the repo's TypeScript-transpilation tests while replacing provider
// boundaries. Execute real route bodies and the real RBAC helper.
function load(path: string, dependencies: Record<string, unknown>, suffix = ''): Record<string, any> {
  const output = ts.transpileModule(readFileSync(join(root, path), 'utf8') + suffix, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    fileName: path,
  }).outputText;
  const exports = {};
  new Function('require', 'exports', output)((name: string) => {
    if (!(name in dependencies)) throw new Error(`Unexpected test dependency: ${name}`);
    return dependencies[name];
  }, exports);
  return exports;
}

function operation(overrides = {}) {
  return {
    id, phase: 'recovery_required', committed: false, rolledBack: false,
    cleanupComplete: false, recoveryRequired: true, pending: true, errorCode: 'restore_failed',
    ...overrides,
  };
}

function fixture() {
  const state = {
    session: { isAdmin: true } as { isAdmin: boolean; authMethod?: string } | null,
    csrf: true, reads: 0, updates: 0, recoveries: 0, installed: true,
    operation: null as ReturnType<typeof operation> | null,
    readError: false,
    update: async (_config: any, _emit: any) => ({ success: true }),
    recover: async (_appId: string, _id: string) => {},
  };
  const next = { NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) } };
  const rbac = load('src/lib/auth/rbac.ts', {
    'next/server': next, './session': { getSession: async () => state.session },
  });
  const dependencies: Record<string, any> = {
    'next/server': next,
    '@/lib/auth/rbac': rbac,
    '@/lib/auth/session': {
      verifyCSRFToken: async (token: string) => state.csrf
        && (token === 'csrf' || state.session?.authMethod === 'cli'),
    },
    '@/lib/market/installed-apps': { getInstalledApp: async () => state.installed ? {} : null },
    '@/lib/market/update-operations': {
      getAppUpdateOperation: () => {
        state.reads++;
        if (state.readError) throw new Error('secret journal /protected/path password=hidden');
        return state.operation;
      },
      recoverAppUpdateOperation: async (appId: string, operationId: string) => {
        state.recoveries++;
        await state.recover(appId, operationId);
      },
    },
    '@/lib/market/updater': {
      updateMarketApp: async (config: any, emit: any) => {
        state.updates++;
        return state.update(config, emit);
      },
    },
  };
  dependencies['@/lib/market/update-http'] = load('src/lib/market/update-http.ts', dependencies);
  Object.assign(dependencies, {
    '@/lib/auth': { getSession: async () => state.session },
    '@/lib/apps/definitions': { getAppDefinition: () => null },
    '@/lib/apps/updater': {}, '@/lib/apps/lxd-updater': {}, '@/lib/apps/lxd-updates': {},
    '@/lib/spine/client': {}, '@/lib/updates/state': {}, '@/lib/infrastructure/system-updater': {},
    '@/lib/ui-bridge/auth': { validateBridgeToken: async () => null },
  });
  dependencies['@/lib/auth/session'].getSession = async () => state.session;
  return {
    state,
    canonical: load('src/app/api/apps/[name]/update/route.ts', dependencies).POST,
    settings: load('src/app/settings/api/apps/[appId]/update/route.ts', dependencies).POST,
    bridge: load('src/app/api/ui-bridge/updates/[component]/route.ts', dependencies).POST,
    http: dependencies['@/lib/market/update-http'] as any,
    status: load('src/app/api/market/update/status/route.ts', dependencies).GET,
    recovery: load('src/app/api/market/update/recovery/route.ts', dependencies).POST,
    update: load('src/app/api/market/update/route.ts', dependencies).POST,
  };
}

function request(body: unknown = { appId: 'wiki', id }, token = 'csrf') {
  return new Request('https://youeye.test/api/market/update', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
    body: JSON.stringify(body),
  });
}
const statusRequest = (appId = 'wiki') =>
  new Request(`https://youeye.test/api/market/update/status?appId=${encodeURIComponent(appId)}`);

test('status, update and recovery require an authenticated admin before accessing operations', async () => {
  for (const session of [null, { isAdmin: false }]) {
    const f = fixture();
    f.state.session = session;
    for (const [handler, req] of [[f.status, statusRequest()], [f.update, request()], [f.recovery, request()]] as const) {
      assert.equal((await handler(req)).status, session ? 403 : 401);
    }
    assert.equal(f.state.reads + f.state.updates + f.state.recoveries, 0);
  }
});

test('mutations verify CSRF before reading operations or updating/recovering', async () => {
  const f = fixture();
  f.state.csrf = false;
  assert.equal((await f.update(request())).status, 403);
  assert.equal((await f.recovery(request())).status, 403);
  assert.equal(f.state.reads + f.state.updates + f.state.recoveries, 0);
  f.state.csrf = true;
  assert.equal((await f.update(request(undefined, ''))).status, 403);
  assert.equal((await f.recovery(request(undefined, ''))).status, 403);
  // Status is read-only and does not need a CSRF token.
  assert.equal((await f.status(statusRequest())).status, 200);
});

test('CLI authentication delegates CSRF bypass to the established verifier', async () => {
  const f = fixture();
  f.state.session = { isAdmin: true, authMethod: 'cli' };
  f.state.operation = operation({ pending: false, cleanupComplete: true });
  assert.equal((await f.recovery(request(undefined, ''))).status, 200);
});

test('app and operation IDs are bounded and reject paths, malformed bodies and invalid UUIDs', async () => {
  const f = fixture();
  for (const appId of ['', '../wiki', 'Wiki', 'a'.repeat(64), 'wiki/db', 'wiki\n']) {
    assert.equal((await f.status(statusRequest(appId))).status, 400);
    assert.equal((await f.update(request({ appId }))).status, 400);
    assert.equal((await f.recovery(request({ appId, id }))).status, 400);
  }
  for (const invalid of [null, [], 'text', { appId: 42 }, { appId: 'wiki', confirm_switch: 'yes' }]) {
    assert.equal((await f.update(request(invalid))).status, 400);
  }
  for (const invalidId of ['', '../journal', 'a'.repeat(500), otherId.toUpperCase(), 123]) {
    assert.equal((await f.recovery(request({ appId: 'wiki', id: invalidId }))).status, 400);
  }
  const malformed = () => new Request('https://youeye.test/api/market/update', {
    method: 'POST', headers: { 'X-CSRF-Token': 'csrf' }, body: '{',
  });
  assert.equal((await f.update(malformed())).status, 400);
  assert.equal((await f.recovery(malformed())).status, 400);
  assert.equal(f.state.reads, 0);
});

test('status returns a no-store, explicitly projected operation or null without journal handles', async () => {
  const f = fixture();
  assert.deepEqual(await (await f.status(statusRequest())).json(), { operation: null });
  f.state.operation = Object.assign(operation({ committed: true, phase: 'cleanup', recoveryRequired: false }), {
    checkpoints: [{ reference: '/secret/dump.sql' }], resources: ['private'], credentials: 'hidden',
  });
  const response = await f.status(statusRequest());
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { operation: operation({ committed: true, phase: 'cleanup', recoveryRequired: false }) });
  f.state.operation.errorCode = '/secret/path password=hidden';
  assert.equal((await (await f.status(statusRequest())).json()).operation.errorCode, null);
  f.state.readError = true;
  const failed = await f.status(statusRequest());
  assert.equal(failed.status, 503);
  assert.doesNotMatch(await failed.text(), /secret|protected|password|hidden/);
});

test('recovery refuses absent or stale operations and does not look up a supplied foreign ID', async () => {
  const f = fixture();
  assert.equal((await f.recovery(request())).status, 404);
  f.state.operation = operation();
  assert.equal((await f.recovery(request({ appId: 'wiki', id: otherId }))).status, 409);
  assert.equal(f.state.recoveries, 0);
});

test('recovery targets the current exact operation; repeated completed recovery is a no-op', async () => {
  const f = fixture();
  f.state.operation = operation();
  f.state.recover = async (appId, operationId) => {
    assert.equal(appId, 'wiki');
    assert.equal(operationId, id);
    f.state.operation = operation({
      phase: 'rolled_back', rolledBack: true, pending: false,
      cleanupComplete: true, recoveryRequired: false,
    });
  };
  assert.deepEqual(await (await f.recovery(request())).json(), { success: true });
  assert.deepEqual(await (await f.recovery(request())).json(), { success: true });
  assert.equal(f.state.recoveries, 2);
  assert.equal(f.state.updates, 0);
});

test('completed recovery clears only verified current health evidence without provider effects', async () => {
  const record: any = { id, appId: 'wiki', createdAt: '2026-01-01', cleanupComplete: true,
    rollbackVerifiedAt: '2026-01-01' };
  const records = [record];
  const resolved: string[] = [];
  const operations = load('src/lib/market/update-operations.ts', {
    './update-admission': { appUpdateJournalStore: () => ({ read: () => record, list: () => records }),
      withAppLifecycle: () => { throw new Error('Completed recovery must not acquire a provider executor'); } },
    './update-transaction': {}, './update-provider': {},
    '../pointer/release-metadata': { PointerReleaseMetadataProvider: class { constructor() { throw new Error('Completed recovery must not create a Pointer provider'); } } },
    './update-release-metadata': { ReleaseMetadataUpdateProvider: class { constructor() { throw new Error('Completed recovery must not create a release provider'); } } },
    '@/lib/health/issues': { resolveIssue: async (issue: string) => { resolved.push(issue); }, observeIssue: async () => {} },
  });
  await operations.recoverAppUpdateOperation('wiki', id);
  assert.deepEqual(resolved, ['app.wiki.update-recovery']);
  record.rollbackVerifiedAt = undefined;
  await assert.rejects(operations.recoverAppUpdateOperation('wiki', id), /not verified complete/);
  record.commit = { at: '2026-01-01' };
  await operations.recoverAppUpdateOperation('wiki', id);
  records.push({ id: otherId, appId: 'wiki', createdAt: '2026-01-02', cleanupComplete: false });
  await assert.rejects(operations.recoverAppUpdateOperation('wiki', id), /not verified complete/);
  assert.equal(resolved.length, 2);
});

test('committed cleanup can be retried without starting another update', async () => {
  const f = fixture();
  f.state.operation = operation({ committed: true, phase: 'cleanup', recoveryRequired: false });
  f.state.recover = async () => { f.state.operation = operation({ committed: true, pending: false, cleanupComplete: true }); };
  assert.equal((await f.update(request())).status, 409);
  assert.equal((await f.recovery(request())).status, 200);
  assert.equal(f.state.updates, 0);
  assert.equal(f.state.recoveries, 1);
});

test('a busy or failed recovery returns a safe retry response and preserves pending evidence', async () => {
  const f = fixture();
  f.state.operation = operation();
  f.state.recover = async () => { throw new Error('password=hidden /secret/dump.sql journal-handle'); };
  const response = await f.recovery(request());
  assert.equal(response.status, 409);
  assert.doesNotMatch(await response.text(), /hidden|secret|dump.sql|journal-handle/);
  assert.equal((await (await f.status(statusRequest())).json()).operation.pending, true);
  assert.equal((await f.update(request())).status, 409);
  assert.equal(f.state.updates, 0);
});

test('repeated update requests observe pending state and cannot start a second update', async () => {
  const f = fixture();
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  f.state.update = async () => {
    f.state.operation = operation({ phase: 'applying', recoveryRequired: false });
    await gate;
    f.state.operation = operation({ phase: 'committed', committed: true, pending: false, cleanupComplete: true, recoveryRequired: false });
    return { success: true };
  };
  const first = await f.update(request());
  assert.equal(first.headers.get('content-type'), 'text/event-stream');
  assert.equal((await f.update(request())).status, 409);
  assert.equal(f.state.updates, 1);
  finish();
  assert.match(await first.text(), /"stage":"completed"/);
});

test('pre-journal races rely on parent durable admission and never report a rejected update as successful', async () => {
  const f = fixture();
  let locked = false;
  let mutations = 0;
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  f.state.update = async () => {
    if (locked) throw new Error('App update executor lock is busy');
    locked = true;
    mutations++;
    await gate;
    return { success: true };
  };
  const first = await f.update(request());
  const second = await f.update(request());
  assert.match(await second.text(), /"stage":"failed"/);
  assert.equal(mutations, 1);
  finish();
  assert.match(await first.text(), /"stage":"completed"/);
});

test('concurrent recovery requests respect the parent executor without a second recovery mutation', async () => {
  const f = fixture();
  f.state.operation = operation();
  let mutations = 0;
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  f.state.recover = async () => {
    if (mutations) throw new Error('App update executor lock is busy');
    mutations++;
    await gate;
    f.state.operation = operation({ cleanupComplete: true, pending: false });
  };
  const first = f.recovery(request());
  // Yield until the first handler has entered the mocked executor.
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal((await f.recovery(request())).status, 409);
  assert.equal(mutations, 1);
  finish();
  assert.equal((await first).status, 200);
  assert.equal(f.state.updates, 0);
});

test('SSE never exposes provider output or reports intermediate steps as update success', async () => {
  const f = fixture();
  f.state.update = async (_config, emit) => {
    emit({ status: 'success', step: 1, totalSteps: 2, message: 'password=hidden /secret/provider.log' });
    f.state.operation = operation({ committed: true, phase: 'cleanup', recoveryRequired: false });
    return { success: true };
  };
  const text = await (await f.update(request({ appId: 'wiki', confirm_switch: true }))).text();
  assert.match(text, /"stage":"pending"/);
  assert.doesNotMatch(text, /"stage":"completed"|hidden|secret|provider.log/);
  f.state.operation = null;
  f.state.update = async () => { throw Object.assign(new Error('/secret'), { code: 'unsupported-shared-resource' }); };
  assert.match(await (await f.update(request())).text(), /shared storage.*writers/);
});

test('an unavailable status fails closed before update; missing installed apps return 404', async () => {
  const f = fixture();
  f.state.readError = true;
  assert.equal((await f.update(request())).status, 503);
  assert.equal(f.state.updates, 0);
  f.state.readError = false;
  f.state.installed = false;
  assert.equal((await f.update(request())).status, 404);
});

function uiFixture(op: ReturnType<typeof operation> | null, updateAvailable = false, unavailable = false) {
  const app = { id: 'wiki', displayName: 'Wiki', category: 'user', icon: 'book', updateAvailable };
  const values: any[] = [
    [app], false, false, new Map(), new Map([['wiki', op]]),
    unavailable ? new Set(['wiki']) : new Set(), new Set(), null, false, false,
  ];
  let index = 0;
  const activeRequests = { current: new Set<string>() };
  const stub = () => null;
  const dependencies = {
    react: {
      useState: () => {
        const slot = index++;
        return [values[slot], (value: any) => { values[slot] = typeof value === 'function' ? value(values[slot]) : value; }];
      },
      useRef: () => activeRequests,
      useMemo: (fn: () => unknown) => fn(), useCallback: (fn: unknown) => fn, useEffect: () => {},
    },
    'react/jsx-runtime': require('react/jsx-runtime'),
    'next/link': { default: stub },
    'lucide-react': new Proxy({}, { get: () => stub }),
    '@/components/ui/button': { Button: ({ children, ...props }: any) => React.createElement('button', props, children) },
    '@/components/ui/badge': { Badge: stub },
    '@/components/ui/alert': { Alert: stub },
    '@/components/ui/confirm-dialog': { ConfirmDialog: stub },
    '@/components/ui/label': { Label: stub },
    '@/components/ui/select': {},
    '@/components/ui/switch': {},
    '@/components/setup/WordArtPickerInline': {},
    './api-base': {},
    './update-channels': {},
  };
  const client = load('src/components/settings-shell/apps-client.tsx', dependencies, '\nexport { AdminAppSections };');
  return {
    app, values,
    tree: () => { index = 0; return client.AdminAppSections({ onOpen: stub }); },
    html: () => {
      index = 0;
      return renderToStaticMarkup(React.createElement(client.AdminAppSections, { onOpen: stub }));
    },
  };
}

function buttons(tree: any): any[] {
  if (Array.isArray(tree)) return tree.flatMap(buttons);
  if (!React.isValidElement(tree)) return [];
  const props = tree.props as any;
  return [...(props.onClick ? [tree] : []), ...buttons(props.children)];
}
function buttonLabel(button: any) {
  return React.Children.toArray(button.props.children).filter((child) => typeof child === 'string').join('');
}

test('existing update UI renders pending and cleanup recovery even without an update badge', () => {
  const recovery = uiFixture(operation()).html();
  assert.match(recovery, /Wiki/);
  assert.match(recovery, /Retry recovery/);
  assert.match(recovery, /Recovery required/);
  assert.match(recovery, /disabled=""/);
  assert.match(recovery, /Writable shared storage.*preflight/);
  const cleanup = uiFixture(operation({ phase: 'cleanup', committed: true, recoveryRequired: false })).html();
  assert.match(cleanup, /Update committed; cleanup is pending/);
  assert.match(cleanup, /Retry recovery/);
  assert.doesNotMatch(cleanup, /Update complete/);
});

test('recovery UI sends the exact operation and CSRF token once on repeated clicks', async (t) => {
  const ui = uiFixture(operation());
  const calls: { url: string; options?: RequestInit }[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string, options?: RequestInit) => {
    calls.push({ url: input, options });
    if (input === '/settings/api/auth/csrf') return Response.json({ csrfToken: 'csrf' });
    if (input === '/api/market/update/recovery') return Response.json({ success: true });
    if (input.startsWith('/api/market/update/status')) {
      return Response.json({ operation: operation({ rolledBack: true, pending: false, cleanupComplete: true }) });
    }
    if (input === '/api/apps/unified') return Response.json({ apps: [ui.app] });
    throw new Error(`Unexpected request ${input}`);
  });
  const retry = buttons(ui.tree()).find((button) => buttonLabel(button) === 'Retry recovery');
  assert.ok(retry);
  await Promise.all([retry.props.onClick(), retry.props.onClick()]);
  const recoveries = calls.filter((call) => call.url === '/api/market/update/recovery');
  assert.equal(recoveries.length, 1);
  assert.equal(recoveries[0].options?.method, 'POST');
  assert.equal(new Headers(recoveries[0].options?.headers).get('X-CSRF-Token'), 'csrf');
  assert.deepEqual(JSON.parse(recoveries[0].options?.body as string), { appId: 'wiki', id });
  assert.equal(calls.some((call) => call.url === '/api/market/update'), false);
  assert.ok(calls.some((call) => call.url === '/api/market/update/status?appId=wiki'));
  assert.equal((ui.values[4] as Map<string, any>).get('wiki').rolledBack, true);
});

test('pending or unavailable status disables updates and the click handler cannot bypass the guard', async (t) => {
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string) => { calls.push(input); return Response.json({}); });
  for (const ui of [uiFixture(operation(), true), uiFixture(null, true, true)]) {
    const update = buttons(ui.tree()).find((button) => ['Pending', 'Update'].includes(buttonLabel(button)));
    assert.ok(update);
    assert.equal(update.props.disabled, true);
    await update.props.onClick();
  }
  assert.deepEqual(calls, []);
});

test('the Market update UI handles a truncated SSE stream as interrupted and refreshes durable status', async (t) => {
  const ui = uiFixture(null, true);
  const calls: { url: string; options?: RequestInit }[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string, options?: RequestInit) => {
    calls.push({ url: input, options });
    if (input === '/settings/api/auth/csrf') return Response.json({ csrfToken: 'csrf' });
    if (input === '/api/market/update') {
      return new Response('event: update\ndata: {"stage":"rebuilding","message":"Updating application...","progress":10}\n\n');
    }
    if (input.startsWith('/api/market/update/status')) return Response.json({ operation: operation() });
    if (input === '/api/apps/unified') return Response.json({ apps: [ui.app] });
    throw new Error(`Unexpected request ${input}`);
  });
  const update = buttons(ui.tree()).find((button) => buttonLabel(button) === 'Update');
  assert.ok(update);
  await Promise.all([update.props.onClick(), update.props.onClick()]);
  const updates = calls.filter((call) => call.url === '/api/market/update');
  assert.equal(updates.length, 1);
  assert.deepEqual(JSON.parse(updates[0].options?.body as string), { appId: 'wiki' });
  assert.equal((ui.values[3] as Map<string, any>).get('wiki').status, 'failed');
  assert.equal((ui.values[4] as Map<string, any>).get('wiki').recoveryRequired, true);
  assert.match(ui.html(), /Retry recovery/);
});

for (const [route, parameter] of [['canonical', 'name'], ['settings', 'appId'], ['bridge', 'component']] as const) {
  test(`${route} Market updates require admin and CSRF even through legacy/bridge paths`, async () => {
    const f = fixture();
    const params = { params: Promise.resolve({ [parameter]: 'wiki' }) };
    f.state.session = { isAdmin: false };
    assert.equal((await f[route](request(), params)).status, 403);
    assert.equal(f.state.updates, 0);
    f.state.session = { isAdmin: true };
    f.state.csrf = false;
    assert.equal((await f[route](request(), params)).status, 403);
    assert.equal(f.state.updates, 0);
  });
  test(`${route} uses durable pending state and sanitized final outcome`, async () => {
    const f = fixture();
    const params = { params: Promise.resolve({ [parameter]: 'wiki' }) };
    f.state.operation = operation();
    assert.equal((await f[route](request(), params)).status, 409);
    assert.equal(f.state.updates, 0);
    f.state.operation = null;
    f.state.update = async (_config, emit) => {
      emit({ status: 'success', step: 1, totalSteps: 2, message: 'secret-provider-output' });
      f.state.operation = operation({ committed: true, phase: 'cleanup' });
      return { success: true };
    };
    const response = await f[route](request(), params);
    const text = await response.text();
    assert.match(text, /pending/);
    assert.doesNotMatch(text, /secret-provider-output|"stage":"completed"|"status":"success"/);
    f.state.operation = null;
    f.state.update = async () => { throw new Error('secret-provider-output'); };
    assert.doesNotMatch(await (await f[route](request(), params)).text(), /secret-provider-output/);
  });
}
