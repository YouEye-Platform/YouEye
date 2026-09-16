import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { link, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import {
  classifyMarketNativeSignatureAssets,
  inspectMarketNativeArchive,
} from '../src/lib/market/native-artifact';

const execFileAsync = promisify(execFile);
const completeSignatureSet = [
  'release-development.pub',
  'SHA256SUMS',
  'SHA256SUMS.sig',
  'provenance.json',
  'sbom.spdx.json',
];

test('Market-native release classification accepts absence and complete evidence only', () => {
  assert.equal(classifyMarketNativeSignatureAssets(['standalone.tar']), 'unsigned');
  assert.equal(
    classifyMarketNativeSignatureAssets(['standalone.tar', 'SHA256SUMS', 'provenance.json', 'sbom.spdx.json']),
    'unsigned',
  );
  assert.equal(classifyMarketNativeSignatureAssets(['standalone.tar', ...completeSignatureSet]), 'complete');
  assert.throws(
    () => classifyMarketNativeSignatureAssets(['standalone.tar', 'SHA256SUMS.sig']),
    /incomplete signature bundle/,
  );
});

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
