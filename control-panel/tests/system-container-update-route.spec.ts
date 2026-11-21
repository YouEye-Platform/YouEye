import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import ts from 'typescript';

// `youeye app update caddy|pihole|postgres` calls POST /api/apps/<id>/update. It used to reach updateOCIApp, which
// answered "App caddy has no imageRef" (no built-in app has one). The route's real body and the real shared action
// run here; the rebuild itself, the locks and the health issues are stand-ins.
const root = process.env.CONTROL_PANEL_ROOT || join(import.meta.dirname, '..');

function load(path: string, dependencies: Record<string, unknown>): Record<string, any> {
  const output = ts.transpileModule(readFileSync(join(root, path), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: path,
  }).outputText;
  const exports = {};
  new Function('require', 'exports', output)((name: string) => {
    if (!(name in dependencies)) throw new Error(`Unexpected test dependency: ${name}`);
    return dependencies[name];
  }, exports);
  return exports;
}

const definitions: Record<string, any> = {
  caddy: { id: 'caddy', displayName: 'Caddy', type: 'oci-single', systemImageId: 'caddy', updatedBy: 'control-panel', containers: [{ name: 'youeye-caddy' }] },
  postgres: { id: 'postgres', displayName: 'PostgreSQL', type: 'oci-single', systemImageId: 'postgresql', updatedBy: 'control-panel', containers: [{ name: 'youeye-postgres' }] },
  spine: { id: 'spine', displayName: 'Spine', type: 'system', updatedBy: 'spine', containers: [] },
};

function fixture() {
  const state = {
    session: { isAdmin: true } as { isAdmin: boolean } | null,
    csrf: true,
    order: [] as string[],
    options: [] as Array<Record<string, unknown>>,
    ignoredIssues: [] as string[][],
    rebuild: async (options: Record<string, unknown>, onEvent: (event: Record<string, unknown>) => void) => {
      onEvent({ step: 1, totalSteps: 2, status: 'running', message: 'Rebuilding youeye-caddy' });
      return { success: true, systemId: options.systemId, message: 'Caddy updated to 2.10.2', newVersion: '2.10.2' } as Record<string, unknown>;
    },
  };
  const action = load('src/lib/apps/system-container-update.ts', {
    '@/lib/health/issues': {
      assertNoCriticalIssues: async (_operation: string, _scope: unknown, ignored: string[]) => { state.ignoredIssues.push(ignored); },
    },
    '@/lib/infrastructure/system-updater': {
      updateSystemContainer: async (options: Record<string, unknown>, onEvent: (event: Record<string, unknown>) => void) => {
        state.order.push('rebuild');
        state.options.push(options);
        return state.rebuild(options, onEvent);
      },
    },
    '@/lib/market/update-admission': {
      withUserOperationLockWait: async (work: () => unknown) => { state.order.push('operation-lock'); return work(); },
      withPlatformLifecycle: async (work: () => unknown) => { state.order.push('platform-lifecycle'); return work(); },
    },
  });
  const route = load('src/app/api/apps/[name]/update/route.ts', {
    '@/lib/auth': { getSession: async () => state.session, verifyCSRFToken: async (token: string) => state.csrf && token === 'csrf' },
    '@/lib/apps/definitions': { getAppDefinition: (id: string) => definitions[id] },
    '@/lib/apps/lxd-updater': { updateLXDApp: async () => { throw new Error('not an LXD app'); } },
    '@/lib/apps/system-container-update': action,
    '@/lib/market/update-admission': { withUserOperationLockWait: async (work: () => unknown) => work() },
    '@/lib/market/update-http': { handleMarketUpdate: async () => Response.json({ market: true }) },
  });
  const update = async (name: string, body?: unknown) => {
    const response: Response = await route.POST(
      new Request(`http://control/api/apps/${name}/update`, {
        method: 'POST',
        headers: { 'X-CSRF-Token': 'csrf', 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      { params: Promise.resolve({ name }) },
    );
    const text = await response.text();
    const events = text.split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)));
    return { response, events };
  };
  return { state, update };
}

test('a system container update through /api/apps/<id>/update rebuilds on the pinned image under both locks', async () => {
  const f = fixture();
  const { response, events } = await f.update('caddy', { confirmMaintenanceWindow: true, confirmContainerName: 'youeye-caddy' });
  assert.equal(response.headers.get('Content-Type'), 'text/event-stream');
  assert.deepEqual(f.state.order, ['operation-lock', 'platform-lifecycle', 'rebuild']);
  assert.deepEqual(f.state.options, [{
    systemId: 'caddy', hostIP: process.env.HOST_IP || '', confirmMaintenanceWindow: true,
    confirmContainerName: 'youeye-caddy', allowDatabaseUpdate: false,
  }]);
  // The container's own failure does not block the update that may repair it.
  assert.deepEqual(f.state.ignoredIssues, [['service.caddy.down', 'container.youeye-caddy.crash-loop']]);
  assert.deepEqual(events.map((event) => event.stage), ['starting', 'rebuilding', 'completed']);
  assert.equal(events.at(-1).message, 'Caddy updated to 2.10.2');
  assert.doesNotMatch(JSON.stringify(events), /imageRef/);
});

test('without the acknowledgement (the CLI) the answer says where the update is, and nothing is touched', async () => {
  for (const body of [undefined, { confirm_switch: true }]) {
    const f = fixture();
    const { events } = await f.update('caddy', body);
    assert.deepEqual(f.state.order, []);
    assert.deepEqual(events.map((event) => event.stage), ['failed']);
    assert.match(events[0].message, /Caddy is a system container.*Settings → Apps/);
    assert.doesNotMatch(events[0].message, /imageRef/);
  }
});

test('a refused or failed rebuild ends the stream as failed with its reason', async () => {
  const f = fixture();
  f.state.rebuild = async () => ({ success: false, message: 'refused', error: 'PostgreSQL system updates require allowDatabaseUpdate' });
  const { events } = await f.update('postgres', { confirmMaintenanceWindow: true, confirmContainerName: 'youeye-postgres' });
  assert.equal(f.state.options[0].systemId, 'postgresql');
  assert.equal(events.at(-1).stage, 'failed');
  assert.match(events.at(-1).message, /require allowDatabaseUpdate/);
});

test('admin and CSRF are checked before a system container update, and Spine still updates with the System release', async () => {
  const f = fixture();
  f.state.csrf = false;
  assert.equal((await f.update('caddy', { confirmMaintenanceWindow: true })).response.status, 403);
  f.state.csrf = true;
  f.state.session = { isAdmin: false };
  assert.equal((await f.update('caddy', { confirmMaintenanceWindow: true })).response.status, 403);
  f.state.session = { isAdmin: true };
  const { events } = await f.update('spine');
  assert.match(events[0].message, /updates with the System release/);
  assert.deepEqual(f.state.order, []);
});
