// YE-221: Incus looks an exec's command up through the exec's PATH, which is the image's own for an OCI container
// unless the request sets one. A bare `sh` (or `chmod`) in an image whose PATH lacks /bin answered 127 although the
// image has a shell, and a Nix image keeps `sh` outside /bin. Execs now pass the image's PATH followed by the standard
// directories. A fake Incus runs each exec here, finding the command through the request's PATH as Incus 7.0.1 does
// (checked on a lab clone): an image with PATH=/opt/app/bin (no /bin), a Nix-like image (sh only in its own PATH, no
// /bin/sh), or no shell at all.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

type Image = 'path-without-bin' | 'nix' | 'no-shell';
const STANDARD = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

async function withFakeIncus(image: Image, run: (execs: Array<{ command: string[]; path: string }>) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'exec-image-path-'));
  const socket = join(directory, 'incus.sock');
  // The Nix-like image keeps its shell in a store directory and has no /bin/sh.
  const nixBin = join(directory, 'nix-store', 'bin');
  await mkdir(nixBin, { recursive: true });
  await symlink('/bin/sh', join(nixBin, 'sh'));
  const imagePath = image === 'nix' ? nixBin : '/opt/app/bin';
  const execs: Array<{ command: string[]; path: string }> = [];
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    response.setHeader('content-type', 'application/json');
    if (request.method === 'GET') {
      assert.equal(request.url, '/1.0/instances/app-fixture');
      response.end(JSON.stringify({ type: 'sync', status_code: 200,
        metadata: { name: 'app-fixture', expanded_config: { 'environment.PATH': imagePath } } }));
      return;
    }
    assert.match(request.url!, /^\/1\.0\/instances\/app-fixture\/exec$/);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const command: string[] = body.command;
    // Incus passes the request's variables over the image's own; the command is found through the resulting PATH.
    const env = { PATH: imagePath, ...body.environment };
    execs.push({ command, path: env.PATH });
    const shellMissing = (image === 'no-shell' && /(^|\/)sh$/.test(command[0]))
      || (image === 'nix' && command[0].startsWith('/bin/'));
    const result = shellMissing ? { status: 127, stdout: '', stderr: '' }
      : spawnSync(command[0], command.slice(1), { env, encoding: 'utf8' });
    const exitCode = 'error' in result && result.error ? 127 : result.status;
    response.end(JSON.stringify({ type: 'sync', status_code: 200,
      metadata: { metadata: { return: exitCode, output: { 1: result.stdout ?? '', 2: result.stderr ?? '' } } } }));
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  const oldSocket = process.env.INCUS_SOCKET;
  const oldHttps = process.env.INCUS_HTTPS_URL;
  process.env.INCUS_SOCKET = socket;
  delete process.env.INCUS_HTTPS_URL;
  try {
    await run(execs);
  } finally {
    if (oldSocket === undefined) delete process.env.INCUS_SOCKET; else process.env.INCUS_SOCKET = oldSocket;
    if (oldHttps === undefined) delete process.env.INCUS_HTTPS_URL; else process.env.INCUS_HTTPS_URL = oldHttps;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}

test('the fake images are what they claim: a bare sh in the image PATH alone answers 127, /bin/sh is missing in Nix', async () => {
  await withFakeIncus('path-without-bin', async () => {
    const { execCommand } = await import('../src/lib/incus/server');
    assert.equal((await execCommand('app-fixture', ['sh', '-c', 'echo ready'])).exitCode, 127);
    assert.equal((await execCommand('app-fixture', ['chmod', '0600', '/nonexistent'])).exitCode, 127);
  });
  await withFakeIncus('nix', async () => {
    const { execCommand } = await import('../src/lib/incus/server');
    assert.equal((await execCommand('app-fixture', ['/bin/sh', '-c', 'echo ready'])).exitCode, 127);
    assert.equal((await execCommand('app-fixture', ['sh', '-c', 'echo ready'])).stdout.trim(), 'ready');
  });
});

test('an image whose PATH lacks /bin has a shell: the probe finds sh, and chmod and stat still run', async () => {
  await withFakeIncus('path-without-bin', async (execs) => {
    const { waitForContainerExec } = await import('../src/lib/incus/snapshot');
    assert.deepEqual(await waitForContainerExec('app-fixture', 2), { shell: true });
    assert.deepEqual(execs, [{ command: ['sh', '-c', 'echo ready'], path: `/opt/app/bin:${STANDARD}` }],
      'the image PATH first, then the standard directories');

    const directory = await mkdtemp(join(tmpdir(), 'exec-image-path-config-'));
    try {
      const file = join(directory, 'config');
      await writeFile(file, 'secret');
      await chmod(directory, 0o755);
      await chmod(file, 0o644);
      const { enforceConfigFilePermissions } = await import('../src/lib/market/config-writer');
      await enforceConfigFilePermissions('app-fixture', { container: 'main', path: file, permission: '0o600',
        directoryPermission: '0o700', template: 'secret' } as never, {});
      assert.equal((await stat(directory)).mode & 0o7777, 0o700);
      assert.equal((await stat(file)).mode & 0o7777, 0o600);
      assert.deepEqual(execs[1].command, ['sh', '-c', 'echo ready'], 'the permission check probes first');
      assert.deepEqual(execs.slice(2).map(({ command }) => command.join(' ')),
        [`chmod 0700 ${directory}`, `stat -c %a ${directory}`, `chmod 0600 ${file}`, `stat -c %a ${file}`]);
      assert.ok(execs.every(({ path }) => path === `/opt/app/bin:${STANDARD}`));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

test('a Nix image keeps sh outside /bin: it still has a shell, found through its own PATH', async () => {
  await withFakeIncus('nix', async (execs) => {
    const { waitForContainerExec } = await import('../src/lib/incus/snapshot');
    assert.deepEqual(await waitForContainerExec('app-fixture', 2), { shell: true });
    const { execShell } = await import('../src/lib/incus/server');
    const result = await execShell('app-fixture', 'command -v sh; echo "$PATH"');
    assert.equal(result.exitCode, 0);
    const [found, path] = result.stdout.trim().split('\n');
    assert.match(found, /nix-store\/bin\/sh$/, 'the image\'s own sh comes first');
    assert.ok(path.endsWith(`:${STANDARD}`));
    assert.equal(execs.length, 2);
  });
});

test('a caller\'s own PATH is kept', async () => {
  await withFakeIncus('path-without-bin', async (execs) => {
    const { execShell } = await import('../src/lib/incus/server');
    await execShell('app-fixture', 'true', { environment: { PATH: '/bin', LANG: 'C' } });
    assert.deepEqual(execs, [{ command: ['sh', '-c', 'true'], path: '/bin' }]);
  });
});

test('an image without sh is still shell-less, and its files: take the host-side check', async () => {
  await withFakeIncus('no-shell', async (execs) => {
    const { waitForContainerExec } = await import('../src/lib/incus/snapshot');
    assert.deepEqual(await waitForContainerExec('app-fixture', 2), { shell: false });
    assert.equal(execs.length, 1, 'one probe, no 30 s wait');
    const { enforceConfigFilePermissions } = await import('../src/lib/market/config-writer');
    // No volume to read host-side: the check says so instead of running chmod.
    await assert.rejects(enforceConfigFilePermissions('app-fixture', { container: 'main', path: '/etc/garage/garage.toml',
      permission: '0o600', directoryPermission: '0o700', template: 'secret' } as never, {}),
    /has no shell and its configuration is not on app storage/);
    assert.equal(execs.length, 2, 'only the second probe ran, no chmod');
  });
});

test('the standard directories an image already lists are not repeated', async () => {
  const { imageExecPath } = await import('../src/lib/incus/server');
  const directory = await mkdtemp(join(tmpdir(), 'exec-image-path-dedupe-'));
  const socket = join(directory, 'incus.sock');
  const server = http.createServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ type: 'sync', status_code: 200,
      metadata: { expanded_config: { 'environment.PATH': '/opt/app/bin:/usr/bin:/bin' } } }));
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  const oldSocket = process.env.INCUS_SOCKET;
  process.env.INCUS_SOCKET = socket;
  try {
    assert.equal(await imageExecPath('app-fixture'), '/opt/app/bin:/usr/bin:/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/sbin');
  } finally {
    if (oldSocket === undefined) delete process.env.INCUS_SOCKET; else process.env.INCUS_SOCKET = oldSocket;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
