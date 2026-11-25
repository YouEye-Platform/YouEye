/**
 * YE-215: an OCI image whose /etc/hosts, /etc/resolv.conf or /etc/hostname is a symlink (Collabora CODE) gets empty
 * regular files there before its first start, because Incus 7.0.1 refuses to mount its network files over a link.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { OCI_NETWORK_FILES, replaceSymlinkedNetworkFiles, type NetworkFileIO } from '../src/lib/infrastructure/oci-network-files';
import { loadSource } from './fixtures/update-provider-harness';

const root = process.env.CONTROL_PANEL_ROOT || path.join(import.meta.dirname, '..');
type Kind = 'file' | 'directory' | 'symlink' | null;

/** A rootfs of path → kind; `fail` makes one call on one path throw; every call is logged. */
function rootfs(initial: Record<string, Kind>, fail: { call?: 'inspect' | 'remove' | 'createEmpty'; path?: string; stays?: boolean } = {}) {
  const files = { ...initial };
  const calls: string[] = [];
  const io: NetworkFileIO = {
    async inspect(p) {
      calls.push(`inspect ${p}`);
      if (fail.call === 'inspect' && fail.path === p) throw new Error('Incus file inspection failed');
      return files[p] ?? null;
    },
    async remove(p) {
      calls.push(`remove ${p}`);
      if (fail.call === 'remove' && fail.path === p) throw new Error('Incus file deletion failed');
      delete files[p];
    },
    async createEmpty(p) {
      calls.push(`create ${p}`);
      if (fail.call === 'createEmpty' && fail.path === p) throw new Error('Incus file upload failed');
      // `stays`: the write followed something and the path is still not a regular file.
      files[p] = fail.stays && fail.path === p ? 'symlink' : 'file';
    },
  };
  return { io, files, calls };
}

test('the three network files Incus mounts over are the ones checked', () => {
  assert.deepEqual([...OCI_NETWORK_FILES], ['/etc/hosts', '/etc/resolv.conf', '/etc/hostname']);
});

test('symlinked network files are deleted, then created as empty regular files (Collabora CODE)', async () => {
  const f = rootfs({ '/etc/hosts': 'symlink', '/etc/resolv.conf': 'symlink', '/etc/hostname': 'file' });
  assert.deepEqual(await replaceSymlinkedNetworkFiles('app-collabora', f.io), ['/etc/hosts', '/etc/resolv.conf']);
  assert.deepEqual(f.files, { '/etc/hosts': 'file', '/etc/resolv.conf': 'file', '/etc/hostname': 'file' });
  // The link is removed before anything is written: nothing is written through it into its target.
  assert.deepEqual(f.calls, [
    'inspect /etc/hosts', 'remove /etc/hosts', 'create /etc/hosts', 'inspect /etc/hosts',
    'inspect /etc/resolv.conf', 'remove /etc/resolv.conf', 'create /etc/resolv.conf', 'inspect /etc/resolv.conf',
    'inspect /etc/hostname',
  ]);
});

test('an ordinary image (regular files, a directory, missing files) is not changed', async () => {
  const f = rootfs({ '/etc/hosts': 'file', '/etc/resolv.conf': 'file' });
  assert.deepEqual(await replaceSymlinkedNetworkFiles('app-sonarr', f.io), []);
  assert.deepEqual(f.calls, ['inspect /etc/hosts', 'inspect /etc/resolv.conf', 'inspect /etc/hostname']);
  const g = rootfs({ '/etc/hosts': 'directory' });
  assert.deepEqual(await replaceSymlinkedNetworkFiles('app-odd', g.io), []);
  assert.ok(!g.calls.some((call) => /^(remove|create)/.test(call)));
});

test('a failure to check or replace is an install error that names the path, never a silent skip', async () => {
  for (const [call, message] of [
    ['inspect', /Could not check \/etc\/resolv\.conf in app-collabora before its first start/],
    ['remove', /Could not replace the symlinked \/etc\/resolv\.conf in app-collabora with a regular file/],
    ['createEmpty', /Could not replace the symlinked \/etc\/resolv\.conf in app-collabora with a regular file/],
  ] as const) {
    const f = rootfs({ '/etc/hosts': 'symlink', '/etc/resolv.conf': 'symlink' }, { call, path: '/etc/resolv.conf' });
    const error: any = await replaceSymlinkedNetworkFiles('app-collabora', f.io).catch((e: unknown) => e);
    assert.match(error.message, message);
    assert.ok(error.cause instanceof Error, 'the Incus cause is kept for the journal');
    assert.ok(!f.calls.includes('inspect /etc/hostname'), 'it stops at the first failure');
  }
  // A path that does not read back as a regular file after the write is refused too.
  const f = rootfs({ '/etc/hosts': 'symlink' }, { path: '/etc/hosts', stays: true });
  const error: any = await replaceSymlinkedNetworkFiles('app-collabora', f.io).catch((e: unknown) => e);
  assert.match(error.message, /Could not replace the symlinked \/etc\/hosts/);
  assert.match(error.cause.message, /did not read back as a regular file/);
});

test('app containers are fixed after creation and after an update\'s rebuild, before they start', () => {
  const deployer = readFileSync(path.join(root, 'src/lib/infrastructure/oci-deployer.ts'), 'utf8');
  const deploy = deployer.slice(deployer.indexOf('export async function deployOCIContainer('));
  const create = deploy.indexOf("'/1.0/instances',");
  const replace = deploy.lastIndexOf('await replaceSymlinkedNetworkFiles(manifest.containerName)');
  const start = deploy.lastIndexOf('await startOCIContainer(manifest.containerName)');
  assert.ok(create > 0 && replace > create && start > replace);
  assert.match(deploy, /if \(options\?\.owner\) \{\s*const \{ replaceSymlinkedNetworkFiles \}/);
  const updater = readFileSync(path.join(root, 'src/lib/market/updater.ts'), 'utf8');
  assert.match(updater, /oci-replace-\$\{i\}`, async \(\) => \{\s*await rebuildContainer\(name, artifact\.image\);[\s\S]{0,200}?await replaceSymlinkedNetworkFiles\(name\);/);
  assert.ok(updater.indexOf('await replaceSymlinkedNetworkFiles(name)') < updater.indexOf('`first-start-${i}`'));
});

test('a failed inspection is retried (3 tries, never the delete or the write); a third failure is the error', async () => {
  const flaky = (failures: number) => {
    const f = rootfs({ '/etc/hosts': 'symlink' });
    const inspect = f.io.inspect;
    let left = failures;
    f.io.inspect = async (p) => {
      if (p === '/etc/hosts' && left > 0) { left--; f.calls.push(`inspect ${p} (failed)`); throw new Error('Incus file API timeout'); }
      return inspect(p);
    };
    return f;
  };
  const once = flaky(1);
  assert.deepEqual(await replaceSymlinkedNetworkFiles('app-collabora', once.io, { retryDelayMs: 0 }), ['/etc/hosts']);
  assert.deepEqual(once.calls.slice(0, 4), ['inspect /etc/hosts (failed)', 'inspect /etc/hosts', 'remove /etc/hosts', 'create /etc/hosts']);
  const always = flaky(3);
  const error: any = await replaceSymlinkedNetworkFiles('app-collabora', always.io, { retryDelayMs: 0 }).catch((e: unknown) => e);
  assert.match(error.message, /Could not check \/etc\/hosts in app-collabora before its first start/);
  assert.equal(always.calls.filter((call) => call.startsWith('inspect')).length, 3);
  assert.ok(!always.calls.some((call) => /^(remove|create)/.test(call)));
  // A failed delete is not retried.
  const remove = rootfs({ '/etc/hosts': 'symlink' }, { call: 'remove', path: '/etc/hosts' });
  await assert.rejects(replaceSymlinkedNetworkFiles('app-collabora', remove.io, { retryDelayMs: 0 }));
  assert.deepEqual(remove.calls, ['inspect /etc/hosts', 'remove /etc/hosts']);
});

/** deployOCIContainer adopting a retained runtime over a fake Incus; `replaceFails` makes the network-file fix throw. */
function retainedAdoption(replaceFails = false) {
  const name = 'app-fixture';
  const events: string[] = [];
  let exists = false;
  const deployer = loadSource('lib/infrastructure/oci-deployer.ts', (module: string) => {
    if (module === '../incus/server') return {
      incusRequest: async (method: string, url: string, body?: any) => {
        if (method === 'GET' && url === `/1.0/instances/${name}`) {
          return exists ? { type: 'sync', status_code: 200, metadata: { config: { 'boot.autostart': 'true' } } }
            : { type: 'error', error: 'Instance not found', error_code: 404 };
        }
        if (method === 'GET' && url === `/1.0/instances/${name}/state`) return { type: 'sync', metadata: { status: 'Running' } };
        if (method === 'PATCH') { events.push(`boot:${body.config['boot.autostart']}`); return { type: 'sync' }; }
        if (method === 'PUT' && url.endsWith('/state')) { events.push(`start:${name}`); return { type: 'sync' }; }
        throw new Error(`Unexpected Incus request ${method} ${url}`);
      },
    };
    if (module === '../incus/snapshot') return {};
    if (module === '../incus/static-ips') return { applyStaticIP: async (container: string) => { events.push(`ip:${container}`); } };
    if (module === '../market/instance-ownership') return { ownershipConfig: () => ({ 'user.youeye.app_id': 'fixture' }) };
    if (module === './image-fetch-retry' || module === '../incus/container-ip') return {};
    if (module === '@/lib/admission/retained-runtime') return {
      copyRetainedRuntime: async (binding: { sourceName: string }) => { events.push(`copy:${binding.sourceName}`); exists = true; },
    };
    if (module === './oci-network-files') return {
      replaceSymlinkedNetworkFiles: async (container: string) => {
        events.push(`network-files:${container}`);
        if (replaceFails) throw new Error(`Could not replace the symlinked /etc/hosts in ${container} with a regular file`);
        return [];
      },
    };
    throw new Error(`Unexpected import ${module}`);
  });
  const manifest = { name: 'fixture', containerName: name, image: 'docker.io/library/fixture:1', imageFingerprint: 'abc123',
    environment: {}, ports: [], volumes: [] };
  const retainedRuntime = { appId: 'fixture', installationId: 'i', ownerId: 'o', sourceName: name, retainedName: 'ye-retained-x', pool: 'default' };
  return { events, deploy: () => deployer.deployOCIContainer(manifest, '', undefined, { owner: { kind: 'app' }, retainedRuntime }) };
}

test('a restore that adopts a retained runtime fixes its network files once, after the copy and before the start (YE-221)', async () => {
  const f = retainedAdoption();
  await f.deploy();
  assert.deepEqual(f.events, ['copy:app-fixture', 'network-files:app-fixture', 'boot:true', 'ip:app-fixture', 'start:app-fixture']);
  const failing = retainedAdoption(true);
  await assert.rejects(failing.deploy(), /Could not replace the symlinked \/etc\/hosts in app-fixture/);
  assert.deepEqual(failing.events, ['copy:app-fixture', 'network-files:app-fixture'], 'the adoption fails and nothing starts');
});
