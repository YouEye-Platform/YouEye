// YE-216: an app container from an image without a shell (a static binary such as dxflrs/garage) installs, updates
// and rolls back. The exec-ready probe takes "sh not found" as a ready transport without a shell, and the post-start
// permission check reads the modes host-side from the app's volume. A container with a shell behaves exactly as before.
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { containerOrder, loadSource } from './fixtures/update-provider-harness';

type ExecAnswer = { exitCode: number; stdout: string } | Error;

/** The real `incus/snapshot.ts` over a fake exec: `answers` are consumed in order, the last one repeats. */
function snapshotModule(answers: ExecAnswer[]) {
  const calls: string[] = [];
  const mod = loadSource('lib/incus/snapshot.ts', (name: string) => {
    if (name === './server') return {
      incusRequest: async () => ({ type: 'sync', metadata: {} }),
      execShell: async (container: string, script: string) => {
        calls.push(`${container}: ${script}`);
        const answer = answers[Math.min(calls.length - 1, answers.length - 1)];
        if (answer instanceof Error) throw answer;
        return { stderr: '', ...answer };
      },
    };
    if (name === '../infrastructure/image-fetch-retry') return { retryImageFetch: async (work: () => unknown) => work() };
    return {};
  });
  return { waitForContainerExec: mod.waitForContainerExec as (name: string, maxWait?: number) => Promise<{ shell: boolean }>, calls };
}

const NO_SH = { exitCode: 127, stdout: '' };
const READY = { exitCode: 0, stdout: 'ready\n' };

test('exec readiness: a shell answers ready; an image without sh is ready without a shell (127 or 126)', async () => {
  const shell = snapshotModule([READY]);
  assert.deepEqual(await shell.waitForContainerExec('app-fixture-main'), { shell: true });
  assert.deepEqual(shell.calls, ['app-fixture-main: echo ready']);
  for (const exitCode of [127, 126]) {
    const none = snapshotModule([{ exitCode, stdout: '' }]);
    assert.deepEqual(await none.waitForContainerExec('app-fixture-garage'), { shell: false });
    assert.equal(none.calls.length, 1, 'no 30 s wait for a shell that will never come');
  }
});

test('exec readiness: the early-start race is still waited out, and a transport that never comes still fails', async () => {
  // Right after start Incus can't exec yet (an error, or an exec that did not run): retried, then the answer counts.
  const race = snapshotModule([new Error('Incus exec request failed'), { exitCode: -1, stdout: '' }, NO_SH]);
  assert.deepEqual(await race.waitForContainerExec('app-fixture-garage', 5), { shell: false });
  assert.equal(race.calls.length, 3);
  const never = snapshotModule([new Error('Incus exec request failed')]);
  await assert.rejects(never.waitForContainerExec('app-fixture-garage', 2), /did not become exec-ready within 2s/);
  assert.equal(never.calls.length, 2);
});

/** The update provider over one shell-less OCI container, with the real exec-ready probe. */
function provider(exec: ExecAnswer[]) {
  const name = 'app-fixture-garage';
  const states = new Map([[name, 'Stopped']]);
  const events: string[] = [];
  const snapshot = snapshotModule(exec);
  const plan = {
    metadata: { appId: 'fixture', installedVersion: '1.0.0', containers: [{ name: 'garage', containerName: name, type: 'oci', primary: true }] },
    manifest: { containers: [{ name: 'garage' }] },
    instances: [{ name, config: { 'volatile.base_image': 'garage-image' } }],
  };
  const exports = loadSource('lib/market/update-provider.ts', (module: string) => {
    if (module === '@/lib/apps/container-order') return containerOrder();
    if (module === '@/lib/apps/container-readiness') return loadSource('lib/apps/container-readiness.ts', () => ({}));
    if (module === '@/lib/incus/snapshot') return {
      containerState: async (container: string) => states.get(container),
      startContainer: async (container: string) => { events.push(`start:${container}`); states.set(container, 'Running'); },
      waitForRunning: async (container: string) => { assert.equal(states.get(container), 'Running'); },
      waitForContainerExec: snapshot.waitForContainerExec,
    };
    if (module === '@/lib/incus/server') return {
      incusRequest: async () => ({ type: 'sync', metadata: { name, config: { 'volatile.base_image': 'garage-image' } } }),
    };
    if (module === './metadata') return { readInstallMetadata: async () => ({ installedVersion: '1.0.0' }) };
    return {};
  });
  const instance = new exports.IncusAppUpdateProvider();
  instance.load = () => plan;
  instance.noProviderEffects = () => false;
  instance.postgres = async () => undefined;
  instance.optionalFence = () => undefined;
  // The app's own health check (its HTTP check): the readiness that still has to pass.
  instance.waitReady = async (_plan: unknown, container: string) => { events.push(`ready:${container}`); };
  const record = { appId: 'fixture', id: 'op', phase: 'applying', steps: [], originalRunning: { [name]: true } };
  return { instance, record, states, events, name, execCalls: snapshot.calls };
}

test('update: a container without a shell starts (startRuntime) on Incus state and the exec answer', async () => {
  const f = provider([NO_SH]);
  await f.instance.startRuntime(f.record, f.name);
  assert.equal(f.states.get(f.name), 'Running');
  assert.deepEqual(f.events, ['start:app-fixture-garage']);
  assert.deepEqual(f.execCalls, ['app-fixture-garage: echo ready'], 'one probe, no 30 s wait');
});

test('rollback: a container without a shell is verified restored and its own health check runs', async () => {
  const f = provider([NO_SH]);
  await f.instance.verifyRestored(f.record);
  assert.deepEqual(f.events, ['start:app-fixture-garage', 'ready:app-fixture-garage']);
});

test('update and rollback of a container with a shell: unchanged', async () => {
  const f = provider([READY]);
  await f.instance.startRuntime(f.record, f.name);
  f.states.set(f.name, 'Stopped');
  await f.instance.verifyRestored(f.record);
  assert.deepEqual(f.events, ['start:app-fixture-garage', 'start:app-fixture-garage', 'ready:app-fixture-garage']);
});

/** config-writer's post-start check over a fake volume (paths and modes) and a recording exec. */
function configWriter(shell: boolean, files: Record<string, { type: string; mode: string }>) {
  const execs: string[] = [];
  const inspected: string[] = [];
  const exports = loadSource('lib/market/config-writer.ts', (name: string) => {
    if (name === 'path') return { ...path, default: path };
    if (name === './variables') return { resolveVariables: (value: string) => value };
    if (name === '../incus/snapshot') return { waitForContainerExec: async () => ({ shell }) };
    if (name === '../incus/server') return {
      // chmod and stat run with the image's PATH and then the standard directories (YE-221).
      execInImagePath: async (_container: string, command: string[]) => {
        execs.push(command.join(' '));
        return { exitCode: 0, stdout: command[0] === 'stat' ? (command.at(-1) === '/etc/garage' ? '700' : '600') : '' };
      },
      incusInspectVolumeFile: async (pool: string, volume: string, file: string) => {
        inspected.push(`${pool}/${volume}${file}`);
        return files[file] ?? null;
      },
    };
    throw new Error(`Unexpected import ${name}`);
  });
  const volumes = [{ name: 'app-fixture-garage-config', pool: 'default', containerPath: '/etc/garage', sourcePath: '',
    readOnly: false, containerName: 'app-fixture-garage' }];
  const spec = (file = '/etc/garage/garage.toml', directoryPermission = '0o700') => ({
    container: 'garage', path: file, permission: '0o600', directoryPermission, template: 'secret',
  });
  return {
    execs, inspected, volumes,
    enforce: (file?: string, withVolumes = true, directoryPermission?: string) =>
      exports.enforceConfigFilePermissions('app-fixture-garage', spec(file, directoryPermission), {}, withVolumes ? volumes : undefined),
  };
}

test('install: files: on a shell-less container are checked host-side on the volume, with no exec', async () => {
  // The file in the volume's root: a new volume root is 0711 (traverse only beyond the manifest's 0700).
  const ok = configWriter(false, { '/garage.toml': { type: 'file', mode: '0600' }, '/': { type: 'directory', mode: '0711' } });
  await ok.enforce();
  assert.deepEqual(ok.execs, []);
  assert.deepEqual(ok.inspected, ['default/app-fixture-garage-config/garage.toml', 'default/app-fixture-garage-config/']);
  // A directory the Control Panel created (not the root) must match exactly.
  const nested = configWriter(false, { '/conf/garage.toml': { type: 'file', mode: '0600' }, '/conf': { type: 'directory', mode: '0700' } });
  await nested.enforce('/etc/garage/conf/garage.toml');
  assert.deepEqual(nested.execs, []);
});

test('install: a shell-less container still fails closed on any wider mode', async () => {
  const cases: Array<[string, Record<string, { type: string; mode: string }>, string?]> = [
    ['a readable volume root', { '/garage.toml': { type: 'file', mode: '0600' }, '/': { type: 'directory', mode: '0755' } }],
    ['a wider file', { '/garage.toml': { type: 'file', mode: '0644' }, '/': { type: 'directory', mode: '0700' } }],
    ['a missing file', { '/': { type: 'directory', mode: '0700' } }],
    ['a created directory with traverse bits', { '/conf/garage.toml': { type: 'file', mode: '0600' }, '/conf': { type: 'directory', mode: '0711' } },
      '/etc/garage/conf/garage.toml'],
  ];
  for (const [what, files, file] of cases) {
    const f = configWriter(false, files);
    await assert.rejects(f.enforce(file), /did not read back exactly/, what);
    assert.deepEqual(f.execs, [], what);
  }
  // The volume root may carry extra traverse bits, never fewer than the manifest's dir_mode (YE-221): 0711 is not 0755.
  const narrower = configWriter(false, { '/garage.toml': { type: 'file', mode: '0600' }, '/': { type: 'directory', mode: '0711' } });
  await assert.rejects(narrower.enforce(undefined, true, '0o755'), /did not read back exactly/);
  const exact = configWriter(false, { '/garage.toml': { type: 'file', mode: '0600' }, '/': { type: 'directory', mode: '0755' } });
  await exact.enforce(undefined, true, '0o755');
  const wider = configWriter(false, { '/garage.toml': { type: 'file', mode: '0600' }, '/': { type: 'directory', mode: '0711' } });
  await wider.enforce(undefined, true, '0o701');
  // Without app storage there is nothing host-side to read: said, not guessed.
  const none = configWriter(false, {});
  await assert.rejects(none.enforce(undefined, false), /has no shell and its configuration is not on app storage/);
});

test('install: a container with a shell keeps its chmod and stat path, and never reads the volume', async () => {
  const f = configWriter(true, {});
  await f.enforce();
  assert.deepEqual(f.execs, ['chmod 0700 /etc/garage', 'stat -c %a /etc/garage', 'chmod 0600 /etc/garage/garage.toml', 'stat -c %a /etc/garage/garage.toml']);
  assert.deepEqual(f.inspected, []);
});
