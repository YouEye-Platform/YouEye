import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const root = process.env.CONTROL_PANEL_ROOT || process.cwd();
function load(file: string, mocks: Record<string, any>, extra = ''): any {
  const exports = {};
  const code = ts.transpileModule(readFileSync(path.join(root, file), 'utf8') + extra, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(code, { exports, console, encodeURIComponent, require: (id: string) => mocks[id] ?? {} });
  return exports;
}

function fixture(mode = 'normal', system = true) {
  const name = system ? 'youeye-pointer' : 'app-example';
  const effects: string[] = [];
  let instance: any, watchdogStarts = 0, installed = false;
  const request = async (method: string, route: string, body?: any): Promise<any> => {
    if (method === 'GET') return { type: 'sync', metadata: instance };
    effects.push(`${method}:${route}`);
    if (method === 'POST') {
      instance = { ...body, status: 'Stopped' };
      // Exercise the real action-time watchdog check in the creation/start gap.
      await watchdog.startWatchdogContainer(name);
      if (mode === 'create-error') return { type: 'error', error: 'create rejected' };
    } else if (route.endsWith('/state')) {
      if (mode === 'start-error') return { type: 'error', error: 'start rejected' };
      if (!installed && instance.config['boot.autostart'] !== 'false') watchdogStarts++;
      instance.status = 'Running';
    } else if (body.config?.['boot.autostart'] === 'true') {
      assert.ok(installed, 'restart ownership published before installation completes');
      if (mode === 'enable-error') return { type: 'error', error: 'enable rejected' };
      instance.config['boot.autostart'] = 'true';
    }
    return { type: 'sync' };
  };
  const watchdog = load('src/lib/health/watchdog-start.ts', {
    '../incus/server': { incusRequest: request },
    '../market/update-admission': { withContainerLifecycle: async (_: string, work: () => Promise<any>) => work() },
    '../maintenance/container-maintenance': { isContainerMaintenanceActive: () => false },
    '../market/metadata': { listInstalledApps: async () => [{ containers: [name] }] },
    '../market/storage': { inspectAppStorage: async () => ({ available: true }) },
  });
  const mocks = {
    '../incus/server': { incusRequest: request, execShell: async () => ({ stdout: 'ready', exitCode: 0 }) },
    '../incus/static-ips': {
      getSystemStaticIP: async () => { if (mode === 'subnet-error') throw Error('subnet unavailable'); return system ? '192.0.2.17' : null; },
      applyStaticIP: async () => { if (mode === 'static-error') throw Error('static configuration rejected'); },
    },
    './oci-deployer': { containerExists: async () => false },
    './release-resolver': {
      infrastructureChannelSource: (source: any, repository: string) => ({ source, repository }),
      resolveInfrastructureStandaloneRelease: async () => ({ tag: 'v0.1.0', version: '0.1.0', url: 'https://example.test/standalone.tar' }),
    },
    'fixture-install': { install: async () => { if (mode === 'install-error') throw Error('install rejected'); installed = true; return 'a'.repeat(64); } },
  };
  const api = load('src/lib/infrastructure/lxd-deployer.ts', mocks, '\ninstallNodeAndApp = require("fixture-install").install;');
  return { effects, get instance() { return instance; }, get watchdogStarts() { return watchdogStarts; },
    run: () => api.deployLXDContainer({ name: system ? 'pointer' : 'example', containerName: name, volumes: [
      { kind: 'custom', pool: 'data', source: 'retained', container: '/data' },
    ] }, { giteaBaseURL: 'https://github.com', giteaOrg: 'example', giteaRepo: 'example' },
    system ? undefined : { eth0: { type: 'nic', network: 'app-bridge', name: 'eth0' } }),
  };
}

test('initial system creation pins its NIC atomically and excludes watchdog until installed', async () => {
  const f = fixture(); await f.run();
  assert.equal(f.watchdogStarts, 0);
  assert.equal(f.instance.devices.eth0['ipv4.address'], '192.0.2.17');
  assert.equal(f.instance.config['boot.autostart'], 'true');
  assert.equal(f.instance.devices.volume0.source, 'retained');
});
test('ordinary application creation preserves its isolated NIC and persistent storage', async () => {
  const f = fixture('normal', false); await f.run();
  assert.equal(f.watchdogStarts, 0);
  assert.equal(f.instance.devices.eth0.network, 'app-bridge');
  assert.equal(f.instance.devices.eth0['ipv4.address'], undefined);
  assert.equal(f.instance.devices.volume0.source, 'retained');
});
test('unknown network, rejected static/start/enable and failed installs cannot claim successful deployment', async () => {
  for (const mode of ['subnet-error', 'create-error', 'static-error', 'start-error', 'install-error', 'enable-error']) {
    const f = fixture(mode); await assert.rejects(f.run(), /unavailable|rejected/);
    assert.equal(f.watchdogStarts, 0);
    if (mode === 'subnet-error') assert.equal(f.effects.length, 0);
    else assert.equal(f.instance.config['boot.autostart'], 'false');
  }
});

test('static IP assignment rejects Incus error envelopes and waits for async completion before DNS publication', async () => {
  for (const failure of ['none', 'patch', 'operation', 'dns']) {
    const events: string[] = [];
    const api = load('src/lib/incus/static-ips.ts', {
      './ipv4': { isUsableIPv4: () => true },
      './server': { incusRequest: async (method: string, route: string) => {
        events.push(`${method}:${route}`);
        if (method === 'GET' && route === '/1.0/networks/incusbr0') return { type: 'sync', metadata: { config: { 'ipv4.address': '192.0.2.1/24' } } };
        if (route.includes('/operations/')) return { type: 'sync', metadata: { status: failure === 'operation' ? 'Failure' : 'Success', err: 'rejected operation' } };
        if (route.includes('/instances/')) return failure === 'patch' ? { type: 'error', error: 'rejected patch' } : { type: 'async', operation: '/1.0/operations/static' };
        return failure === 'dns' ? { type: 'error', error: 'rejected DNS' } : { type: 'sync' };
      } },
    });
    if (failure === 'none') {
      await api.applyStaticIP('youeye-pointer');
      const settled = events.findIndex(e => e.includes('/operations/'));
      assert.ok(settled >= 0 && settled < events.indexOf('PATCH:/1.0/networks/incusbr0'));
    } else {
      await assert.rejects(api.applyStaticIP('youeye-pointer'), /rejected/);
      if (failure !== 'dns') assert.ok(!events.includes('PATCH:/1.0/networks/incusbr0'));
    }
  }
});
