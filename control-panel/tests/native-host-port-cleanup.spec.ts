// Run: node --import tsx --test tests/native-host-port-cleanup.spec.ts
// YE-189: at each Control Panel start, the host port the Market's native deploy used to add (`port<N>`, bind host,
// tcp:0.0.0.0:<N>) is removed from app instances, and nothing else is touched.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const root = process.env.CONTROL_PANEL_ROOT || process.cwd();
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
type Devices = Record<string, Record<string, string>>;
type Instance = { name: string; config: Record<string, string>; devices: Devices; profiles: string[] };
type Body = Partial<Instance>;
type Lock = <T>(appId: string, work: () => Promise<T>) => Promise<T>;
type Cleanup = {
  isUnintendedAppHostPort: (name: string, device: Record<string, string> | undefined) => boolean;
  removeAppHostPorts: (records: () => Promise<Map<string, string>>, lock: Lock) => Promise<string[]>;
};

function load(file: string, mocks: Record<string, unknown>): Cleanup {
  const exports = {};
  const code = ts.transpileModule(read(file), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(code, { exports, console: { ...console, log: () => {} }, encodeURIComponent, require: (id: string) => mocks[id] ?? {} });
  return exports as Cleanup;
}

// Objects made inside the loaded module come from another realm: compare them as JSON.
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
const hostPort = (port: number) => ({ type: 'proxy', bind: 'host', listen: `tcp:0.0.0.0:${port}`, connect: `tcp:127.0.0.1:${port}` });
const keep = {
  eth0: { type: 'nic', network: 'app-notes', name: 'eth0' },
  'net-wiki': { type: 'nic', network: 'app-wiki', name: 'eth1' },
  volume0: { type: 'disk', pool: 'default', source: 'app-notes-data', path: '/data' },
  local: { type: 'proxy', bind: 'host', listen: 'tcp:127.0.0.1:3001', connect: 'tcp:127.0.0.1:3001' },
  port5432: { type: 'proxy', bind: 'instance', listen: 'tcp:0.0.0.0:5432', connect: 'tcp:10.0.0.2:5432' },
  port9000: { type: 'proxy', bind: 'host', listen: 'tcp:127.0.0.1:9000', connect: 'tcp:127.0.0.1:9000' },
  port8443: { type: 'proxy', bind: 'host', listen: 'tcp:0.0.0.0:8443', connect: 'tcp:127.0.0.1:443' },
};

function fixture(instances: Record<string, Instance>, options: { putError?: string; busy?: string } = {}) {
  const writes: Array<{ method: string; route: string; body?: Body; lockedBy?: string }> = [];
  const locked: string[] = [];
  let holder: string | undefined;
  // The app's lifecycle lock: refuses a busy app, records who held it during each write.
  const lock: Lock = async (appId, work) => {
    locked.push(appId);
    if (appId === options.busy) throw new Error(`app ${appId} is busy`);
    holder = appId;
    try { return await work(); } finally { holder = undefined; }
  };
  const request = async (method: string, route: string, body?: Body): Promise<object> => {
    if (method === 'GET' && route === '/1.0/instances?recursion=1') {
      return { type: 'sync', metadata: Object.values(instances).map((i) => structuredClone(i)) };
    }
    const name = decodeURIComponent(route.split('/').pop()!);
    if (method === 'GET') {
      return instances[name] ? { type: 'sync', metadata: structuredClone(instances[name]) } : { type: 'error', error_code: 404 };
    }
    writes.push({ method, route, body, lockedBy: holder });
    if (method === 'PUT') {
      if (options.putError === name) return { type: 'error', error: 'refused' };
      instances[name] = { ...instances[name], ...body };
      return { type: 'sync' };
    }
    if (method === 'PATCH') {
      // Incus merges a PATCH's devices into the instance's.
      instances[name].devices = { ...instances[name].devices, ...body?.devices };
      return { type: 'sync' };
    }
    throw new Error(`unexpected ${method} ${route}`);
  };
  const api = load('src/lib/infrastructure/security-posture.ts', {
    '@/lib/incus/server': { incusRequest: request },
    '@/lib/incus/static-ips': {},
    '@/lib/market/instance-ownership': { APP_TAG: 'user.youeye.app_id' },
  });
  const run = (records: Record<string, string> | (() => Promise<Map<string, string>>) = {}) =>
    api.removeAppHostPorts(typeof records === 'function' ? records : async () => new Map(Object.entries(records)), lock);
  return { api, run, writes, instances, locked };
}

const app = (name: string, devices: Devices, config: Record<string, string> = { 'user.youeye.app_id': 'notes' }) =>
  ({ name, config, devices, profiles: ['default'], architecture: 'x86_64', ephemeral: false, stateful: false, description: '' });

test('the exact host-port shape is recognised and nothing like it', () => {
  const { api } = fixture({});
  assert.equal(api.isUnintendedAppHostPort('port3000', hostPort(3000)), true);
  assert.equal(api.isUnintendedAppHostPort('port3001', hostPort(3001)), true);
  for (const [name, device] of Object.entries(keep)) assert.equal(api.isUnintendedAppHostPort(name, device), false, name);
  assert.equal(api.isUnintendedAppHostPort('port3000', hostPort(3001)), false);
  assert.equal(api.isUnintendedAppHostPort('port3000', { ...hostPort(3000), type: 'nic' }), false);
  assert.equal(api.isUnintendedAppHostPort('port3000', undefined), false);
  assert.equal(api.isUnintendedAppHostPort('port03000', hostPort(3000)), false);
});

test('removes the host port of tagged and recorded app instances and keeps every other device', async () => {
  const f = fixture({
    'app-notes': app('app-notes', { ...keep, port3000: hostPort(3000) }),
    // Installed before ownership tags: recognised by its install record.
    'app-search': app('app-search', { eth0: keep.eth0, port3001: hostPort(3001) }, {}),
  });
  const removed = await f.run({ 'app-search': 'search' });
  assert.deepEqual([...removed].sort(), ['app-notes/port3000', 'app-search/port3001']);
  assert.deepEqual(plain(f.instances['app-notes'].devices), keep);
  assert.deepEqual(plain(f.instances['app-search'].devices), { eth0: keep.eth0 });
  // A full PUT that keeps config and profiles (a PATCH cannot remove a device).
  assert.ok(f.writes.every((w) => w.method === 'PUT'));
  // Each write ran under the lock of the app that owns the instance.
  assert.deepEqual(f.writes.map((w) => [w.route, w.lockedBy]).sort(),
    [['/1.0/instances/app-notes', 'notes'], ['/1.0/instances/app-search', 'search']]);
  assert.deepEqual(plain(f.instances['app-notes'].config), { 'user.youeye.app_id': 'notes' });
  assert.deepEqual(plain(f.instances['app-notes'].profiles), ['default']);

  // A second run finds nothing and writes nothing.
  const writes = f.writes.length;
  assert.deepEqual([...await f.run({ 'app-search': 'search' })], []);
  assert.equal(f.writes.length, writes);
});

test('platform containers and instances of no app are never touched', async () => {
  let recordsRead = 0;
  const f = fixture({
    'youeye-caddy': app('youeye-caddy', { port80: hostPort(80), port443: hostPort(443) }, {}),
    'youeye-control': app('youeye-control', { port3000: hostPort(3000) }, { 'user.youeye.app_id': 'notes' }),
    'someones-vm': app('someones-vm', { port8080: hostPort(8080) }, {}),
    'app-clean': app('app-clean', keep),
  });
  assert.deepEqual([...await f.run(async () => { recordsRead++; return new Map([['app-clean', 'clean']]); })], []);
  assert.deepEqual(f.writes, []);
  assert.equal(f.instances['youeye-caddy'].devices.port80.listen, 'tcp:0.0.0.0:80');
  assert.equal(recordsRead, 1);
  assert.deepEqual(f.locked, [], 'no app lock taken for an instance of no app');
  // With nothing of the shape anywhere, the install records are not even read.
  const clean = fixture({ 'app-clean': app('app-clean', keep) });
  await clean.run(async () => { throw new Error('records read'); });
});

test('a refused removal is reported and the other apps are still cleaned', async () => {
  const f = fixture({
    'app-notes': app('app-notes', { eth0: keep.eth0, port3001: hostPort(3001) }),
    'app-wiki': app('app-wiki', { eth0: keep.eth0, port3002: hostPort(3002) }, { 'user.youeye.app_id': 'wiki' }),
  }, { putError: 'app-notes' });
  await assert.rejects(f.run(), /app-notes: .*refused.*/);
  assert.equal(f.instances['app-notes'].devices.port3001.listen, 'tcp:0.0.0.0:3001');
  assert.deepEqual(plain(f.instances['app-wiki'].devices), { eth0: keep.eth0 });
});

test('an app busy with an operation keeps its port until the next start, and the others are cleaned', async () => {
  const f = fixture({
    'app-notes': app('app-notes', { eth0: keep.eth0, port3001: hostPort(3001) }),
    'app-wiki': app('app-wiki', { eth0: keep.eth0, port3002: hostPort(3002) }, { 'user.youeye.app_id': 'wiki' }),
  }, { busy: 'notes' });
  await assert.rejects(f.run(), /Host ports left in place \(1 removed\): app-notes: (Error: )?app notes is busy/);
  assert.equal(f.instances['app-notes'].devices.port3001.listen, 'tcp:0.0.0.0:3001');
  assert.ok(f.writes.every((w) => w.route !== '/1.0/instances/app-notes'), 'nothing written to the busy app');
  assert.deepEqual(plain(f.instances['app-wiki'].devices), { eth0: keep.eth0 });
});

test('the Control Panel runs the cleanup at start, after update recovery and before the app reconciler', () => {
  const source = read('src/instrumentation.ts');
  const recovery = source.indexOf('reconcileAppUpdateOperations()');
  const cleanup = source.indexOf('removeAppHostPorts()');
  const reconciler = source.indexOf('startAppReconciler()');
  assert.ok(recovery > 0 && recovery < cleanup && cleanup < reconciler);
});
