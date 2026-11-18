import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { appIdFromRouteId, appRouteId } from '../src/lib/caddy/app-route-id';

const root = process.env.CONTROL_PANEL_ROOT || process.cwd();
const DOMAIN = 'warm-shore.ui.bingo';

// The route list of a real box (koshka VM 156, 2026-11-18), with app routes as 0.6.8 creates them, plus: a route left
// by a removed app, an app route made before 0.6.8 (never offered), the owner's custom control and DNS subdomains and
// a route the owner added by hand (all with generated `route-…` ids, never offered).
const ROUTES = [
  { id: 'api-ping-route', path: '/api/ping', upstream: '10.106.73.16', port: 3000, enabled: true },
  { id: 'control-pointer-assets-route', hostname: DOMAIN, path: '/api/pointer-ui', upstream: '10.106.73.16', port: 3000, enabled: true },
  { id: 'control-settings-route', hostname: DOMAIN, path: '/settings', upstream: '10.106.73.16', port: 3000, enabled: true },
  { id: 'control-market-route', hostname: DOMAIN, path: '/market', upstream: '10.106.73.16', port: 3000, enabled: true },
  { id: 'pointer-inference-route', hostname: DOMAIN, path: '/v1', upstream: '10.106.73.17', port: 3000, enabled: true },
  { id: 'app-route-bazarr-1794953095072-ts2ng1aiy', hostname: `bazarr.${DOMAIN}`, path: '/', upstream: '10.106.73.16', port: 80, enabled: true },
  { id: 'app-route-stirling-pdf-1794929048878-htqnuplxr', hostname: `stirling-pdf.${DOMAIN}`, path: '/', upstream: '10.106.73.16', port: 80, enabled: true },
  { id: 'route-1794675084080-162de2tyu', hostname: DOMAIN, path: '/', upstream: '10.106.73.15', port: 3000, enabled: true },
  { id: 'youeye-id-route', hostname: `id.${DOMAIN}`, path: '/', upstream: '10.106.73.16', port: 3000, enabled: true },
  { id: 'route-1794675083999-s3dt5xxqx', hostname: `dns.${DOMAIN}`, path: '/', upstream: '10.106.73.14', port: 80, enabled: true },
  { id: 'route-1794675083959-avdwvynk4', hostname: `control.${DOMAIN}`, path: '/', upstream: '10.106.73.16', port: 3000, enabled: true },
  { id: 'route-1794929048000-oldapp001', hostname: `old-app.${DOMAIN}`, path: '/', upstream: '10.106.73.16', port: 80, enabled: true },
  { id: 'route-1794675083111-custom001', hostname: `admin.${DOMAIN}`, path: '/', upstream: '10.106.73.16', port: 3000, enabled: true },
  { id: 'route-1794675083222-custom002', hostname: `adblock.${DOMAIN}`, path: '/', upstream: '10.106.73.14', port: 80, enabled: true },
  { id: 'route-1794675083333-handmade1', hostname: `nas.${DOMAIN}`, path: '/', upstream: '192.168.31.50', port: 5000, enabled: true },
  { id: 'default-catchall', path: '/', upstream: '10.106.73.16', port: 3000, enabled: true },
];

const installed = [{ appId: 'bazarr', containers: [], storageVolumes: [{ pool: 'default', name: 'ye-app-bazarr-config' }] }];
const retained = [{ appId: 'kept', containers: [], storageVolumes: [{ pool: 'default', name: 'ye-app-kept-data' }] }];

function loadDetector(state: { removed: string[]; deleted: string[]; databases?: string[]; keepRoutes?: boolean }) {
  const api: any = {};
  const code = ts.transpileModule(readFileSync(path.join(root, 'src/lib/market/orphan-detector.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const incus = {
    execShell: async () => ({ exitCode: 0, stdout: (state.databases ?? []).join('\n') }),
    execCommand: async () => ({ exitCode: 0, stdout: '' }),
    incusRequest: async (method: string, url: string) => {
      if (method === 'DELETE') { state.deleted.push(url); return { type: 'sync' }; }
      if (url === '/1.0/instances?recursion=1') return { metadata: [] };
      if (url === '/1.0/storage-pools') return { metadata: ['/1.0/storage-pools/default'] };
      if (url.endsWith('/volumes/custom?recursion=1')) {
        return { metadata: ['ye-app-bazarr-config', 'ye-app-kept-data', 'ye-app-gone-data'].map((name) => ({ name, type: 'custom', config: { 'user.youeye.kind': 'app' }, used_by: [] })) };
      }
      const name = url.split('/').pop();
      return { type: 'sync', metadata: { config: { 'user.youeye.kind': 'app' }, used_by: [], name } };
    },
  };
  const modules: Record<string, unknown> = {
    './metadata': { listInstalledApps: async () => installed, listRetainedApps: async () => retained },
    '../caddy/client': {
      getRoutes: async () => ROUTES.filter((route) => state.keepRoutes || !state.removed.includes(route.id)),
      removeRoute: async (id: string) => { state.removed.push(id); },
    },
    '../caddy/app-route-id': { appIdFromRouteId },
    './instance-ownership': { INSTALLATION_TAG: 'user.youeye.installation_id', readInstanceConfig: async () => null },
    '../incus/server': incus,
  };
  runInNewContext(code, {
    exports: api, Promise, Set, Map, Error, String,
    require(id: string) {
      if (Object.hasOwn(modules, id)) return modules[id];
      throw Error(`Unexpected dependency: ${id}`);
    },
  });
  return api;
}

test('platform routes and databases are never offered; an app route without an install is', async () => {
  const state = { removed: [] as string[], deleted: [] as string[], databases: ['youeye_ui', 'pihole', 'pointer', 'bazarr', 'stale_app'] };
  const orphans = Array.from(await loadDetector(state).detectOrphans() as any[]);
  const routes = orphans.filter((orphan: any) => orphan.type === 'caddy-route').map((orphan: any) => String(orphan.identifier));
  assert.deepEqual(routes, [`stirling-pdf.${DOMAIN}`]);
  const databases = orphans.filter((orphan: any) => orphan.type === 'postgres-db').map((orphan: any) => String(orphan.identifier));
  assert.deepEqual(databases, ['stale_app']);
  const volumes = orphans.filter((orphan: any) => orphan.type === 'storage-volume').map((orphan: any) => String(orphan.identifier));
  assert.deepEqual(volumes, ['default/ye-app-gone-data'], 'installed and retained volumes are owned');
});

test('app route ids name their app; no other id does', () => {
  for (const app of ['bazarr', 'stirling-pdf', 'a', 'x2']) assert.equal(appIdFromRouteId(appRouteId(app)), app);
  for (const id of ['route-1794675083959-avdwvynk4', 'control-settings-route', 'youeye-id-route', 'app-route--1-a', 'app-route-Bad-1-a']) {
    assert.equal(appIdFromRouteId(id), null, id);
  }
  assert.throws(() => appRouteId('../x'));
});

test('cleanup re-checks at the write boundary', async () => {
  const state = { removed: [] as string[], deleted: [] as string[] };
  const detector = loadDetector(state);
  // A hand-built request for the box's own name or a platform subdomain removes nothing.
  for (const identifier of [DOMAIN, `control.${DOMAIN}`, `id.${DOMAIN}`, `admin.${DOMAIN}`, `nas.${DOMAIN}`, `old-app.${DOMAIN}`, `bazarr.${DOMAIN}`]) {
    const result = await detector.cleanupOrphan({ type: 'caddy-route', identifier, action: 'can-remove' });
    assert.equal(result.success, false, identifier);
  }
  assert.deepEqual(state.removed, []);
  assert.equal((await detector.cleanupOrphan({ type: 'caddy-route', identifier: `stirling-pdf.${DOMAIN}`, action: 'can-remove' })).success, true);
  assert.deepEqual(state.removed, ['app-route-stirling-pdf-1794929048878-htqnuplxr']);
  // A removal Caddy didn't apply is a failure, not a silent success.
  const stuck = { removed: [] as string[], deleted: [] as string[], keepRoutes: true };
  assert.equal((await loadDetector(stuck).cleanupOrphan({ type: 'caddy-route', identifier: `stirling-pdf.${DOMAIN}`, action: 'can-remove' })).success, false);
  // Data kept by a keep-data uninstall is not removable, even though no instance uses it.
  const kept = await detector.cleanupOrphan({ type: 'storage-volume', identifier: 'default/ye-app-kept-data', action: 'can-remove' });
  assert.equal(kept.success, false);
  assert.equal(state.deleted.length, 0);
  for (const name of ['youeye', 'youeye_ui', 'pihole', 'pointer', 'postgres']) {
    assert.equal((await detector.cleanupOrphan({ type: 'postgres-db', identifier: name, action: 'can-remove' })).success, false, name);
  }
  assert.equal((await detector.cleanupOrphan({ type: 'dns-entry', identifier: `x.${DOMAIN}`, action: 'can-remove' } as any)).success, false);
});
