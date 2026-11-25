import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

// YE-132 Part B: the prober reads the instance record (never `/state`, which makes Incus measure disk usage) and asks
// a service by exec only when the app has no HTTP check or the check fails.

type Fixture = {
  status?: Record<string, string>;
  serviceActive?: boolean;
  httpOk?: boolean;
  healthCheck?: unknown;
  /** Install metadata's own `healthCheck: false` (the only value that turns the HTTP check off). */
  appHealthcheck?: false;
  containers?: unknown[];
};

function prober(fixture: Fixture = {}) {
  const calls = { requests: [] as string[], execs: [] as string[], fetches: 0, cancelled: 0, statuses: [] as Array<{ state: string; level?: string }> };
  const status = fixture.status ?? { 'app-notes': 'Running' };
  const source = readFileSync(path.join(process.env.CONTROL_PANEL_ROOT || process.cwd(), 'src/lib/market/app-prober.ts'), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const api: any = {};
  const meta = {
    appId: 'notes', installedAt: '2026-01-01T00:00:00Z', enabled: true, desiredState: 'running',
    ...(fixture.appHealthcheck === false ? { healthCheck: false } : {}),
    containers: fixture.containers ?? [{
      name: 'main', containerName: 'app-notes', type: 'native', primary: true, port: 3000,
      ...(fixture.appHealthcheck === false ? {} : { healthCheck: fixture.healthCheck ?? { type: 'http', path: '/health', retries: 1 } }),
    }],
  };
  runInNewContext(code, {
    exports: api, console, Date, AbortSignal, encodeURIComponent,
    async fetch() {
      calls.fetches += 1;
      if (fixture.httpOk === false) throw new Error('connection refused');
      return { ok: true, status: 200, body: { cancel: async () => { calls.cancelled += 1; } } };
    },
    require(id: string) {
      if (id.endsWith('update-admission')) return { isAppHeld: () => false, isAppHeldByCaller: () => false, isAppUpdateReserved: () => false };
      if (id.endsWith('app-reconciler')) return {
        shouldSuppressAppRecovery: () => false,
        appReconciler: () => ({ request() {}, observeHealthy() {} }),
      };
      if (id.endsWith('installed-apps')) return {
        async getAllInstalledApps() { return [{ appId: 'notes' }]; },
        async updateHealthProbeState() {},
        async updateHealthStatus(_id: string, _status: string, detail: { appHealthState: string; failingLevel?: string }) {
          calls.statuses.push({ state: detail.appHealthState, level: detail.failingLevel });
        },
      };
      if (id.endsWith('metadata')) return { readInstallMetadata: async () => structuredClone(meta) };
      if (id.endsWith('oci-deployer')) return {
        containerExists: async () => assert.fail('the prober reads the instance record itself'),
        getContainerIP: async () => '10.0.0.2',
      };
      if (id.endsWith('incus/server')) return {
        async incusRequest(method: string, route: string) {
          calls.requests.push(`${method} ${route}`);
          const name = decodeURIComponent(route.split('/')[3] ?? '');
          if (!(name in status)) return { type: 'error', error: 'Instance not found', metadata: null };
          return { type: 'sync', status_code: 200, metadata: { name, status: status[name] } };
        },
        async execShell(container: string, command: string) {
          calls.execs.push(`${container}: ${command}`);
          return fixture.serviceActive === false ? { exitCode: 3, stdout: 'inactive\n' } : { exitCode: 0, stdout: 'active\n' };
        },
      };
      if (id.endsWith('health/issues')) return { async observeIssue() {}, async resolveIssue() {} };
      if (id.endsWith('container-maintenance')) return { isContainerMaintenanceActive: () => false };
      if (id.endsWith('storage')) return { inspectAppStorage: async () => ({ available: true }) };
      throw new Error(`Unexpected dependency ${id}`);
    },
  });
  return { calls, probe: () => api.probeInstalledApp('notes') as Promise<{ state: string; failingLevel?: string; detail: string }> };
}

test('a running container is read from its instance record, never from /state', async () => {
  const p = prober();
  const result = await p.probe();
  assert.equal(result.state, 'running');
  assert.deepEqual(p.calls.requests, ['GET /1.0/instances/app-notes']);
  assert.ok(p.calls.requests.every(request => !request.endsWith('/state')));
});

test('a healthy native app with an HTTP check makes no exec', async () => {
  const p = prober();
  assert.equal((await p.probe()).state, 'running');
  assert.equal(p.calls.fetches, 1);
  // The probe lets go of the response body (left unread, a later socket end threw in Node's HTTP client; YE-213).
  assert.equal(p.calls.cancelled, 1);
  assert.deepEqual(p.calls.execs, []);
});

test('failing HTTP and an inactive service report L2', async () => {
  const p = prober({ httpOk: false, serviceActive: false });
  const result = await p.probe();
  assert.equal(result.failingLevel, 'L2');
  assert.match(result.detail, /app-notes\.service is not active/);
  assert.deepEqual(p.calls.execs, ["app-notes: systemctl is-active 'app-notes.service'"]);
});

test('failing HTTP and an active service report L3', async () => {
  const p = prober({ httpOk: false, serviceActive: true });
  const result = await p.probe();
  assert.equal(result.failingLevel, 'L3');
  assert.match(result.detail, /connection refused/);
  assert.equal(p.calls.execs.length, 1);
});

test('an app without an HTTP check still asks its service, and reports L2 when it is inactive', async () => {
  const healthy = prober({ appHealthcheck: false });
  assert.equal((await healthy.probe()).state, 'running');
  assert.equal(healthy.calls.fetches, 0);
  assert.equal(healthy.calls.execs.length, 1);

  const inactive = prober({ appHealthcheck: false, serviceActive: false });
  assert.equal((await inactive.probe()).failingLevel, 'L2');
});

test('a stopped or missing container is L1 and asks nothing else', async () => {
  for (const status of [{ 'app-notes': 'Stopped' }, {}]) {
    const p = prober({ status });
    const result = await p.probe();
    assert.equal(result.failingLevel, 'L1');
    assert.deepEqual(p.calls.requests, ['GET /1.0/instances/app-notes']);
    assert.equal(p.calls.fetches, 0);
    assert.deepEqual(p.calls.execs, []);
  }
});

test('an inactive primary service still wins over a waiting dependency, as before', async () => {
  const p = prober({
    httpOk: false, serviceActive: false, status: { 'app-notes': 'Running' },
    containers: [
      { name: 'db', containerName: 'app-notes-db', type: 'oci' },
      { name: 'main', containerName: 'app-notes', type: 'native', primary: true, port: 3000, healthCheck: { type: 'http', retries: 1 } },
    ],
  });
  const result = await p.probe();
  assert.equal(result.failingLevel, 'L2');
  assert.match(result.detail, /app-notes\.service is not active/);
});
