// Run: node --import tsx --test tests/market-native-no-host-port.spec.ts
// YE-189: a native app (and any container the LXD deployer makes) gets no host port: it is reached through Caddy
// and the YouEye gate on its own network, never on tcp:0.0.0.0:<port> of the box.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const root = process.env.CONTROL_PANEL_ROOT || process.cwd();
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
type Devices = Record<string, Record<string, string>>;
type Instance = { status?: string; config?: Record<string, string>; devices: Devices };
type Body = { config?: Record<string, string>; devices?: Devices } | undefined;
type Deployer = { deployLXDContainer: (spec: object, nic?: Devices) => Promise<unknown> };

function load(file: string, mocks: Record<string, unknown>, extra = ''): Record<string, unknown> {
  const exports = {};
  const code = ts.transpileModule(read(file) + extra, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(code, { exports, console, encodeURIComponent, require: (id: string) => mocks[id] ?? {} });
  return exports;
}

test('deploying a container with a port adds no proxy device, at creation or afterwards', async () => {
  for (const port of [3000, 3001, 8080]) {
    let instance: Instance = { devices: {} };
    const writes: Array<{ method: string; route: string; body: Body }> = [];
    const request = async (method: string, route: string, body?: Body): Promise<object> => {
      if (method === 'GET') return { type: 'sync', metadata: instance };
      writes.push({ method, route, body });
      if (method === 'POST') instance = { devices: {}, ...body, status: 'Stopped' };
      else if (route.endsWith('/state')) instance.status = 'Running';
      else if (body?.config) instance.config = { ...instance.config, ...body.config };
      if (body?.devices) instance.devices = body.devices;
      return { type: 'sync' };
    };
    const api = load('src/lib/infrastructure/lxd-deployer.ts', {
      '../incus/server': { incusRequest: request, execShell: async () => ({ stdout: 'ready', exitCode: 0 }) },
      '../incus/static-ips': { getSystemStaticIP: async () => null, applyStaticIP: async () => {} },
      './oci-deployer': { containerExists: async () => false },
      '../releases/core-release': {
        selectedCoreRole: () => ({ release: { tag: 'youeye-v0.1.0-dev.1' }, member: { build_version: '0.1.0-dev.1', artifact: { name: 'ui-standalone.tar', sha256: 'a'.repeat(64), size_bytes: 1 } } }),
        canonicalReleaseRepository: (repository: string) => repository,
        releaseAssetURL: (repository: string, tag: string, blob: { name: string }) => `${repository}/releases/download/${tag}/${blob.name}`,
      },
      '../spine/client': { spineClient: { getReleaseChannel: async () => ({ repository: 'https://example.test/owner/YouEye', channel: 'dev' }) } },
      'fixture-install': { install: async () => 'a'.repeat(64) },
    }, '\ninstallNodeAndApp = require("fixture-install").install;');
    await (api as Deployer).deployLXDContainer({ name: 'notes', containerName: 'app-notes', port },
      { eth0: { type: 'nic', network: 'app-notes-net', name: 'eth0' } });
    const proxies = Object.entries(instance.devices).filter(([, device]) => device.type === 'proxy');
    assert.deepEqual(proxies, [], `port ${port}`);
    assert.ok(writes.every((write) => !write.body?.devices || write.method === 'POST'), `port ${port}: devices changed after creation`);
  }
});

test('no deployer path can build a host proxy for an app any more', () => {
  const lxd = read('src/lib/infrastructure/lxd-deployer.ts');
  assert.doesNotMatch(lxd, /tcp:0\.0\.0\.0|bind: 'host'/);
  assert.doesNotMatch(lxd, /type: 'proxy'/);
  assert.doesNotMatch(lxd, /exposeHostPort|addPortProxy/);
  const engine = read('src/lib/market/engine.ts');
  assert.match(engine, /deployMarketLXDContainer\(lxdSpec, stagedArtifact, appNIC, owner\)/);
  // Market OCI apps are built without ports (the host binds of the OCI deployer belong to Caddy and Pi-hole).
  assert.match(engine, /ports: \[\]/);
});
