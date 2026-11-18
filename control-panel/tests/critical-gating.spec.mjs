import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.env.CONTROL_PANEL_ROOT || path.resolve(import.meta.dirname, '..');
const guardedRoutes = [
  'src/app/settings/api/apps/[appId]/update/route.ts',
  'src/app/api/deploy/infrastructure/system-updates/route.ts',
  'src/app/api/market/install/route.ts',
];

test('platform update, system operations, and app install all invoke the critical issue gate', () => {
  for (const relative of guardedRoutes) {
    const source = fs.readFileSync(path.join(root, relative), 'utf8');
    assert.match(source, /assertNoCriticalIssues\(|hasOpenCriticalIssue\(/, `${relative} must invoke the gate`);
  }
});

// ─── A core container's update and its own issues ────────────────────────────

import { createRequire } from 'node:module';
import ts from 'typescript';

const nodeRequire = createRequire(import.meta.url);

/** Run a source file with its imports replaced; anything unmocked throws on use. */
function load(file, mocks) {
  const output = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: file,
  }).outputText;
  const module = { exports: {} };
  new Function('require', 'exports', 'module', output)((name) => {
    if (name in mocks) return mocks[name];
    if (/^(node:)?(fs|path)$/.test(name)) return nodeRequire(name);
    return new Proxy({}, { get: (_target, property) => property === '__esModule' ? true
      : () => { throw new Error(`Unexpected use of ${name}.${String(property)} in ${file}`); } });
  }, module.exports, module);
  return module.exports;
}

function issue(id, title, severity = 'critical') {
  return { id, title, severity, state: 'open', source: 'test', body: '', firstSeen: '', lastSeen: '', count: 1, fixable: false };
}

function updateRoute(open) {
  const issues = load('src/lib/health/issues.ts', {
    '@/lib/health/issue-store': {
      readHealthRegistry: async () => ({ issues: Object.fromEntries(open.map((entry) => [entry.id, entry])), debounce: {} }),
    },
  });
  const updates = [];
  const statuses = [];
  const route = load('src/app/settings/api/apps/[appId]/update/route.ts', {
    'next/server': { NextResponse: { json: (body, init) => Response.json(body, init) } },
    '@/lib/auth/session': { getSession: async () => ({ isAdmin: true }), verifyCSRFToken: async () => true },
    '@/lib/apps/definitions': load('src/lib/apps/definitions.ts', {}),
    '@/lib/infrastructure/system-updater': {
      updateSystemContainer: async (options) => { updates.push(options.systemId); return { success: true, message: 'updated', newVersion: '2' }; },
    },
    '@/lib/health/issues': issues,
    '@/lib/market/installed-apps': { getInstalledApp: async () => null },
    '@/lib/updates/state': {
      startUpdate: async () => {}, writeStatus: async () => {}, completeUpdate: async () => {}, completeNoOp: async () => {},
      failUpdate: async (component, _version, message) => { statuses.push([component, message]); },
    },
  });
  const post = (appId) => route.POST(new Request('https://cp.example.test/settings/api/apps/x/update', {
    method: 'POST', headers: { 'X-CSRF-Token': 'token' }, body: '{}' }), { params: Promise.resolve({ appId }) });
  return { post, updates, statuses };
}

test('a core container update is not refused for that container being down; other critical issues answer 423', async () => {
  const caddyDown = updateRoute([issue('service.caddy.down', 'Caddy is down')]);
  const repaired = await caddyDown.post('caddy');
  assert.equal(repaired.status, 200, 'the update that repairs Caddy runs');
  assert.deepEqual(caddyDown.updates, ['caddy']);

  const postgres = await caddyDown.post('postgres');
  assert.equal(postgres.status, 423, 'Caddy being down still blocks a PostgreSQL update');
  const body = await postgres.json();
  assert.match(body.error, /critical health issue is open: Caddy is down/);
  assert.equal(body.code, 'critical-issue-open');
  assert.deepEqual(caddyDown.updates, ['caddy']);
  assert.deepEqual(caddyDown.statuses.map(([component]) => component), ['postgres']);

  const disk = updateRoute([issue('service.caddy.down', 'Caddy is down'), issue('host.disk.root', 'Disk usage is critical')]);
  const blocked = await disk.post('caddy');
  assert.equal(blocked.status, 423);
  assert.match((await blocked.json()).error, /Disk usage is critical/);
  assert.deepEqual(disk.updates, []);
});
