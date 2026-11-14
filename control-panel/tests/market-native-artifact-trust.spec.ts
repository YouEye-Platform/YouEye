import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { link, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { inspectMarketNativeArchive } from '../src/lib/market/native-artifact';
import { downloadReleaseFile } from '../src/lib/releases/channel-index';

const MAX = 256 * 1024 * 1024;

const execFileAsync = promisify(execFile);
test('Market-native archive inspection accepts a regular server.js payload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'youeye-native-valid-'));
  try {
    const payload = join(root, 'payload');
    await mkdir(payload);
    await writeFile(join(payload, 'server.js'), 'console.log("ready")\n');
    await mkdir(join(payload, 'public'));
    await writeFile(join(payload, 'public', 'index.txt'), 'ok\n');
    const archive = join(root, 'standalone.tar');
    await execFileAsync('tar', ['-cf', archive, '-C', payload, '.']);
    await inspectMarketNativeArchive(archive, 'server.js');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Market-native archive inspection accepts relative links that remain inside the payload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'youeye-native-relative-link-'));
  try {
    const payload = join(root, 'payload');
    await mkdir(join(payload, 'node_modules', '.pnpm', 'dependency'), { recursive: true });
    await writeFile(join(payload, 'server.js'), 'console.log("ready")\n');
    await writeFile(join(payload, 'node_modules', '.pnpm', 'dependency', 'index.js'), 'module.exports = true\n');
    await symlink('.pnpm/dependency', join(payload, 'node_modules', 'dependency'));
    const archive = join(root, 'standalone.tar');
    await execFileAsync('tar', ['-cf', archive, '-C', payload, '.']);
    await inspectMarketNativeArchive(archive, 'server.js');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Market-native archive inspection rejects escaping links, hard links and missing entrypoints', async () => {
  const root = await mkdtemp(join(tmpdir(), 'youeye-native-invalid-'));
  try {
    for (const [name, target] of [['absolute', '/etc/passwd'], ['relative', '../../outside']]) {
      const linkedPayload = join(root, name);
      await mkdir(join(linkedPayload, 'nested'), { recursive: true });
      await writeFile(join(linkedPayload, 'server.js'), 'console.log("ready")\n');
      await symlink(target, join(linkedPayload, 'nested', 'escape'));
      const linkedArchive = join(root, `${name}.tar`);
      await execFileAsync('tar', ['-cf', linkedArchive, '-C', linkedPayload, '.']);
      await assert.rejects(inspectMarketNativeArchive(linkedArchive, 'server.js'), /symbolic link that leaves the package/);
    }

    const hardLinkedPayload = join(root, 'hard-linked');
    await mkdir(hardLinkedPayload);
    await writeFile(join(hardLinkedPayload, 'server.js'), 'console.log("ready")\n');
    await link(join(hardLinkedPayload, 'server.js'), join(hardLinkedPayload, 'duplicate.js'));
    const hardLinkedArchive = join(root, 'hard-linked.tar');
    await execFileAsync('tar', ['-cf', hardLinkedArchive, '-C', hardLinkedPayload, '.']);
    await assert.rejects(inspectMarketNativeArchive(hardLinkedArchive, 'server.js'), /hard link or unsupported special file/);

    const missingPayload = join(root, 'missing');
    await mkdir(missingPayload);
    await writeFile(join(missingPayload, 'index.js'), 'console.log("wrong")\n');
    const missingArchive = join(root, 'missing.tar');
    await execFileAsync('tar', ['-cf', missingArchive, '-C', missingPayload, '.']);
    await assert.rejects(inspectMarketNativeArchive(missingArchive, 'server.js'), /missing server\.js/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test('release downloads follow HTTPS redirects to any host, never leaving HTTPS', async () => {
  const source = 'https://github.com/YouEye-Platform/Search/releases/download/v0.5.1/standalone.tar';
  const cdn = 'https://release-assets.githubusercontent.com/asset?signature=example';
  const calls: string[] = [];
  const fetcher = async (input: string | URL | Request) => {
    calls.push(String(input));
    return String(input) === source ? new Response(null, {status:302,headers:{location:cdn}}) : new Response('archive');
  };
  assert.equal((await downloadReleaseFile(source, MAX, fetcher as typeof fetch)).toString(), 'archive');
  assert.deepEqual(calls, [source, cdn]);
  // Files are digest-checked, so a mirror or moved CDN is fine.
  for (const location of ['https://mirror.example.test/file', 'https://cdn.example.test:444/file?sig=1']) {
    assert.equal((await downloadReleaseFile(source, MAX, (async (input: string | URL | Request) => String(input) === source ? new Response(null,{status:302,headers:{location}}) : new Response('archive')) as typeof fetch)).toString(), 'archive');
  }
  for (const location of ['http://release-assets.githubusercontent.com/file', 'https://user:password@release-assets.githubusercontent.com/file', cdn+'#fragment', 'https://api.github.com/repos/o/r/releases']) {
    let count = 0;
    await assert.rejects(downloadReleaseFile(source, MAX, (async () => {count++;return new Response(null,{status:302,headers:{location}});}) as typeof fetch), /left HTTPS|listing API/);
    assert.equal(count, 1);
  }
  assert.equal((await downloadReleaseFile('https://forge.example.test/a/b/releases/download/v1/standalone.tar', MAX, (async input=>String(input).endsWith('/attachments/file') ? new Response('private') : new Response(null,{status:302,headers:{location:'/attachments/file'}})) as typeof fetch)).toString(), 'private');
  await assert.rejects(downloadReleaseFile(source, MAX, (async()=>new Response(null,{status:302,headers:{location:source}})) as typeof fetch), /redirect chain/);
  await assert.rejects(downloadReleaseFile(source, MAX, (async()=>new Response('bad',{headers:{'content-length':String(257*1024*1024)}})) as typeof fetch), /exceeds/);
  await assert.rejects(downloadReleaseFile(source, MAX, (async()=>new Response('<html>',{headers:{'content-type':'text/html'}})) as typeof fetch), /HTML/);
});
