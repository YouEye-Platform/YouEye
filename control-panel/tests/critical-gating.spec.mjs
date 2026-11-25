import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.env.CONTROL_PANEL_ROOT || path.resolve(import.meta.dirname, '..');
const guardedRoutes = [
  // The system container update of /settings/api/apps/<id>/update and /api/apps/<id>/update.
  'src/lib/apps/system-container-update.ts',
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
  const held = [];
  const admission = {
    withUserOperationLockWait: (work) => Promise.resolve().then(work),
    withPlatformLifecycle: (work) => { held.push('platform'); return Promise.resolve().then(work); },
  };
  const route = load('src/app/settings/api/apps/[appId]/update/route.ts', {
    'next/server': { NextResponse: { json: (body, init) => Response.json(body, init) } },
    '@/lib/auth/session': { getSession: async () => ({ isAdmin: true }), verifyCSRFToken: async () => true },
    '@/lib/apps/definitions': load('src/lib/apps/definitions.ts', {}),
    '@/lib/apps/system-container-update': load('src/lib/apps/system-container-update.ts', {
      '@/lib/infrastructure/system-updater': {
        updateSystemContainer: async (options) => { updates.push(options.systemId); return { success: true, message: 'updated', newVersion: '2' }; },
      },
      '@/lib/health/issues': issues,
      '@/lib/market/update-admission': admission,
    }),
    '@/lib/health/issues': issues,
    '@/lib/market/update-admission': admission,
    '@/lib/http/lifecycle-busy': { lifecycleRefusalResponse: () => null },
    '@/lib/market/installed-apps': { getInstalledApp: async () => null },
    '@/lib/updates/state': {
      startUpdate: async () => {}, writeStatus: async () => {}, completeUpdate: async () => {}, completeNoOp: async () => {},
      failUpdate: async (component, _version, message) => { statuses.push([component, message]); },
    },
  });
  const post = (appId) => route.POST(new Request('https://cp.example.test/settings/api/apps/x/update', {
    method: 'POST', headers: { 'X-CSRF-Token': 'token' }, body: '{}' }), { params: Promise.resolve({ appId }) });
  return { post, updates, statuses, held };
}

test('a core container update is not refused for that container being down; other critical issues answer 423', async () => {
  const caddyDown = updateRoute([issue('service.caddy.down', 'Caddy is down')]);
  const repaired = await caddyDown.post('caddy');
  assert.equal(repaired.status, 200, 'the update that repairs Caddy runs');
  assert.deepEqual(caddyDown.updates, ['caddy']);
  assert.deepEqual(caddyDown.held, ['platform'], 'the rebuild holds the platform lifecycle');

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

test('the System release parts and Incus have no app update: refused before any status is written', async () => {
  const route = updateRoute([]);
  for (const appId of ['spine', 'control-panel', 'incus', 'host-system']) {
    const response = await route.post(appId);
    assert.equal(response.status, 404, appId);
    assert.match((await response.json()).error, new RegExp(`No update handler for ${appId}`));
  }
  assert.deepEqual(route.updates, []);
  assert.deepEqual(route.statuses, []);
});

test('the install gates ignore only YouEye AI being down (YE-219)', () => {
  const route = fs.readFileSync(path.join(root, 'src/app/api/market/install/route.ts'), 'utf8');
  assert.match(route, /hasOpenCriticalIssue\([^;]*INSTALL_GATE_IGNORED_ISSUES\)/);
  const network = fs.readFileSync(path.join(root, 'src/lib/incus/app-network.ts'), 'utf8');
  assert.equal(network.match(/assertNoCriticalIssues\(`Install \$\{appId\}`, appId, INSTALL_GATE_IGNORED_ISSUES\)/g)?.length, 2);
  // System and pool operations keep the full gate.
  for (const relative of ['src/lib/apps/system-container-update.ts', 'src/app/api/deploy/infrastructure/system-updates/route.ts']) {
    assert.doesNotMatch(fs.readFileSync(path.join(root, relative), 'utf8'), /INSTALL_GATE_IGNORED_ISSUES/, relative);
  }
  const issues = fs.readFileSync(path.join(root, 'src/lib/health/issues.ts'), 'utf8');
  assert.match(issues, /export const INSTALL_GATE_IGNORED_ISSUES: readonly string\[\] = \['service\.pointer\.down'\];/);
  // The AI preflight that refuses an AI-using install while Pointer is down runs before anything is created.
  const engine = fs.readFileSync(path.join(root, 'src/lib/market/engine.ts'), 'utf8');
  assert.ok(engine.indexOf('await preflightManagedAISelection(manifest, config);') < engine.indexOf('await preflightAppNetwork(appId'));
});

test('an AI app adopting retained data while YouEye AI is down is refused before anything is created (YE-223 nit, YE-219)', () => {
  const engine = fs.readFileSync(path.join(root, 'src/lib/market/engine.ts'), 'utf8');
  const install = engine.slice(engine.indexOf('export async function installApp('));
  const prepare = install.indexOf('restoreOptions = await prepareRetainedAdoption(manifest, config);');
  const ai = install.indexOf('await preflightManagedAISelection(manifest, config);');
  const admission = install.indexOf('await ensureAppAdmission(');
  const network = install.indexOf('await preflightAppNetwork(appId');
  assert.ok(prepare > 0 && ai > prepare && network > ai && admission > ai, 'the AI refusal comes before any admission or network change');
  // The adoption prep only reads and checks (record, ownership, storage, the shared database): nothing to undo.
  const retained = fs.readFileSync(path.join(root, 'src/lib/admission/retained-data.ts'), 'utf8');
  const prep = retained.slice(retained.indexOf('export async function prepareRetainedAdoption('), retained.indexOf('async function cleanupAdoptedRoots('));
  assert.doesNotMatch(prep, /\b(write|save|delete|remove|retain|mark|update|create)[A-Z][A-Za-z]*\(/);
  assert.match(prep, /config\.storage = \{ placements \};/);
});
