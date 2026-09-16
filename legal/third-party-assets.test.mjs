#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { lstat, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, posix, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const allowedArgs = new Set(['--verify-noto-upstream', '--verify-screenshot-history']);
for (const arg of args) {
  if (!allowedArgs.has(arg)) {
    throw new Error(`Usage: ${process.argv[1]} [--verify-noto-upstream] [--verify-screenshot-history]`);
  }
}
const verifyNotoUpstream = args.has('--verify-noto-upstream');
const verifyScreenshotHistory = args.has('--verify-screenshot-history');

function gitBlobOID(bytes) {
  return createHash('sha1')
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest('hex');
}

function gitEnvironment() {
  const env = { ...process.env, GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1' };
  for (const name of [
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_COMMON_DIR',
    'GIT_DIR',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_WORK_TREE',
  ]) {
    delete env[name];
  }
  return env;
}

async function gitEntries(repo, commit, paths) {
  const { stdout } = await execFileAsync(
    'git',
    ['--no-replace-objects', '-C', repo, 'ls-tree', '-z', commit, '--', ...paths],
    { env: gitEnvironment(), maxBuffer: 1024 * 1024 },
  );
  const entries = new Map();
  for (const record of stdout.split('\0')) {
    if (!record) continue;
    const separator = record.indexOf('\t');
    assert.notEqual(separator, -1, `invalid Git tree entry: ${record}`);
    const [mode, type, oid] = record.slice(0, separator).split(' ');
    const path = record.slice(separator + 1);
    assert.match(mode, /^100[0-7]{3}$/, `Git path is not a regular file: ${path}`);
    assert.equal(type, 'blob', `Git path is not a blob: ${path}`);
    assert.ok(!entries.has(path), `duplicate Git tree path: ${path}`);
    entries.set(path, oid);
  }
  assert.equal(entries.size, paths.length, 'one or more Git tree paths are unavailable');
  return entries;
}

function readGitObjects(repo, objectIDs) {
  return new Promise((resolveObjects, rejectObjects) => {
    const child = spawn('git', ['--no-replace-objects', '-C', repo, 'cat-file', '--batch'], {
      env: gitEnvironment(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    child.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk) => stderrChunks.push(chunk));
    child.on('error', rejectObjects);
    child.on('close', (code) => {
      if (code !== 0) {
        rejectObjects(new Error(`git cat-file failed: ${Buffer.concat(stderrChunks).toString('utf8').trim()}`));
        return;
      }
      try {
        const output = Buffer.concat(stdoutChunks);
        const objects = [];
        let offset = 0;
        for (const expectedOID of objectIDs) {
          const newline = output.indexOf(0x0a, offset);
          assert.notEqual(newline, -1, `missing Git object header: ${expectedOID}`);
          const header = output.subarray(offset, newline).toString('utf8');
          assert.ok(!header.endsWith(' missing'), `Git object is unavailable locally: ${expectedOID}`);
          const [oid, type, sizeText] = header.split(' ');
          assert.equal(oid, expectedOID, `Git object identity changed: ${expectedOID}`);
          assert.equal(type, 'blob', `Git object is not a blob: ${expectedOID}`);
          const size = Number(sizeText);
          assert.ok(Number.isSafeInteger(size) && size >= 0, `invalid Git object size: ${header}`);
          const start = newline + 1;
          const end = start + size;
          assert.ok(end < output.length && output[end] === 0x0a, `truncated Git object: ${expectedOID}`);
          objects.push(output.subarray(start, end));
          offset = end + 1;
        }
        assert.equal(offset, output.length, 'unexpected trailing Git batch output');
        resolveObjects(objects);
      } catch (error) {
        rejectObjects(error);
      }
    });
    child.stdin.end(`${objectIDs.join('\n')}\n`);
  });
}

const registry = JSON.parse(await readFile(resolve(root, 'legal/third-party-assets.json'), 'utf8'));
assert.equal(registry.schema, 'youeye.third-party-assets.v1');
assert.ok(Array.isArray(registry.assets) && registry.assets.length >= 6);
const ids = new Set();
for (const asset of registry.assets) {
  assert.match(asset.id, /^[a-z0-9][a-z0-9-]*$/);
  assert.ok(!ids.has(asset.id), `duplicate asset id: ${asset.id}`);
  ids.add(asset.id);
  assert.ok(Array.isArray(asset.paths) && asset.paths.length > 0);
  for (const assetPath of asset.paths) await stat(resolve(root, assetPath));
  assert.ok(!(asset.notice && asset.notices), `asset has both notice and notices: ${asset.id}`);
  const notices = asset.notices || (asset.notice ? [asset.notice] : []);
  assert.ok(Array.isArray(notices), `invalid notices for ${asset.id}`);
  for (const notice of notices) await stat(resolve(root, notice));
}
for (const required of ['yescrypt-go', 'lobehub-ai-brand-icons', 'noto-color-emoji-avatars', 'control-panel-font-bundle', 'ui-font-bundle', 'product-screenshots']) {
  assert.ok(ids.has(required), `missing asset record: ${required}`);
}
for (const id of ['control-panel-font-bundle', 'ui-font-bundle']) {
  const asset = registry.assets.find((entry) => entry.id === id);
  assert.deepEqual(asset.notices, ['legal/font-inventory.md', 'legal/text/fonts/OFL-1.1.txt', 'legal/text/fonts/Apache-2.0.txt']);
}

const generated = await readFile(resolve(root, 'THIRD_PARTY_NOTICES.txt'), 'utf8');
for (const id of ids) assert.match(generated, new RegExp(`^${id}$`, 'm'));
const tempDir = await mkdtemp(join(tmpdir(), 'youeye-notices-'));
try {
  const outputPath = resolve(tempDir, 'THIRD_PARTY_NOTICES.txt');
  await execFileAsync(process.execPath, [resolve(root, 'scripts/generate-third-party-notices.mjs'), outputPath]);
  assert.equal(await readFile(outputPath, 'utf8'), generated, 'THIRD_PARTY_NOTICES.txt is stale');
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

const fonts = JSON.parse(await readFile(resolve(root, 'legal/font-inventory.json'), 'utf8'));
assert.equal(fonts.schema, 'youeye.font-inventory.v1');
assert.equal(fonts.families.length, 35);
const fontPaths = new Set();
for (const family of fonts.families) {
  assert.match(family.upstream_commit, /^[0-9a-f]{40}$/);
  assert.match(family.license, /^(OFL-1\.1|Apache-2\.0)$/);
  assert.match(family.license_source, /^https:\/\/github\.com\/google\/fonts\/blob\/[0-9a-f]{40}\//);
  for (const bundled of family.bundled_files) {
    assert.match(bundled.sha256, /^[0-9a-f]{64}$/);
    assert.ok(!fontPaths.has(bundled.path), `duplicate bundled font path: ${bundled.path}`);
    fontPaths.add(bundled.path);
    const bytes = await readFile(resolve(root, bundled.path));
    assert.equal(bytes.length, bundled.bytes, `font byte size changed: ${bundled.path}`);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), bundled.sha256, `font digest changed: ${bundled.path}`);
  }
}
assert.equal(fontPaths.size, 322);

const noto = JSON.parse(await readFile(resolve(root, 'legal/noto-avatar-inventory.json'), 'utf8'));
assert.equal(noto.schema, 'youeye.noto-avatar-inventory.v2');
assert.equal(noto.upstream_repository, 'https://github.com/googlefonts/noto-emoji');
assert.equal(noto.upstream_version, '2.051');
assert.equal(noto.upstream_commit, '8998f5dd683424a73e2314a8c1f1e359c19e8742');
assert.equal(noto.upstream_tree, 'f5de9223f07bb7c738724c53849c15b856ef5b45');
assert.equal(noto.git_object_format, 'sha1');
assert.equal(noto.license, 'OFL-1.1');
assert.equal(noto.rendering_provenance, 'historical-render-recipe-unavailable');
assert.equal(noto.items.length, 96);
const notoIDs = new Set();
for (const item of noto.items) {
  assert.match(item.id, /^[a-z0-9][a-z0-9-]*$/);
  assert.ok(!notoIDs.has(item.id), `duplicate Noto avatar id: ${item.id}`);
  notoIDs.add(item.id);
  assert.match(item.source_path, /^svg\/emoji_u[0-9a-f_]+\.svg$/);
  assert.match(item.source_blob_oid, /^[0-9a-f]{40}$/);
  assert.match(item.source_sha256, /^[0-9a-f]{64}$/);
  const sourceBytes = await readFile(resolve(root, 'legal/upstream/noto-emoji-2.051', item.source_path));
  assert.equal(sourceBytes.length, item.source_bytes, `Noto source byte size changed: ${item.source_path}`);
  assert.equal(gitBlobOID(sourceBytes), item.source_blob_oid, `Noto source Git blob changed: ${item.source_path}`);
  assert.equal(createHash('sha256').update(sourceBytes).digest('hex'), item.source_sha256, `Noto source digest changed: ${item.source_path}`);
  assert.equal(item.output_path, `control-panel/public/profile-avatar-art/${item.id}.png`);
  assert.match(item.output_blob_oid, /^[0-9a-f]{40}$/);
  assert.match(item.output_sha256, /^[0-9a-f]{64}$/);
  const bytes = await readFile(resolve(root, item.output_path));
  assert.equal(bytes.length, item.output_bytes, `avatar byte size changed: ${item.output_path}`);
  assert.equal(gitBlobOID(bytes), item.output_blob_oid, `avatar Git blob changed: ${item.output_path}`);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), item.output_sha256, `avatar digest changed: ${item.output_path}`);
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `not a PNG: ${item.output_path}`);
  assert.equal(bytes.readUInt32BE(16), 96, `avatar width changed: ${item.output_path}`);
  assert.equal(bytes.readUInt32BE(20), 96, `avatar height changed: ${item.output_path}`);
  assert.equal(bytes[24], 8, `avatar bit depth changed: ${item.output_path}`);
  assert.equal(bytes[25], 6, `avatar is not RGBA: ${item.output_path}`);
}
const retainedSourcePaths = (await readdir(resolve(root, 'legal/upstream/noto-emoji-2.051/svg')))
  .filter((name) => name.endsWith('.svg'))
  .map((name) => `svg/${name}`)
  .sort();
assert.deepEqual(
  retainedSourcePaths,
  noto.items.map((item) => item.source_path).sort(),
  'retained Noto source inventory is incomplete',
);
const retainedOutputPaths = (await readdir(resolve(root, 'control-panel/public/profile-avatar-art')))
  .filter((name) => name.endsWith('.png'))
  .map((name) => `control-panel/public/profile-avatar-art/${name}`)
  .sort();
assert.deepEqual(
  retainedOutputPaths,
  noto.items.map((item) => item.output_path).sort(),
  'distributed avatar inventory is incomplete',
);
if (verifyNotoUpstream) {
  const upstreamRepo = process.env.NOTO_UPSTREAM_REPO;
  assert.ok(upstreamRepo, 'NOTO_UPSTREAM_REPO must name a local Git repository for --verify-noto-upstream');
  assert.ok(isAbsolute(upstreamRepo), 'NOTO_UPSTREAM_REPO must be an absolute local path');
  const gitOptions = { env: gitEnvironment() };
  const { stdout: commitOutput } = await execFileAsync(
    'git',
    ['--no-replace-objects', '-C', upstreamRepo, 'rev-parse', '--verify', `${noto.upstream_commit}^{commit}`],
    gitOptions,
  );
  assert.equal(commitOutput.trim(), noto.upstream_commit, 'Noto upstream commit identity changed');
  const { stdout: treeOutput } = await execFileAsync(
    'git',
    ['--no-replace-objects', '-C', upstreamRepo, 'rev-parse', '--verify', `${noto.upstream_commit}^{tree}`],
    gitOptions,
  );
  assert.equal(treeOutput.trim(), noto.upstream_tree, 'Noto upstream tree identity changed');
  const sourcePaths = noto.items.map((item) => item.source_path);
  const entries = await gitEntries(upstreamRepo, noto.upstream_commit, sourcePaths);
  for (const item of noto.items) {
    assert.equal(
      entries.get(item.source_path),
      item.source_blob_oid,
      `Noto upstream blob does not match retained source: ${item.source_path}`,
    );
  }
  const upstreamBytes = await readGitObjects(
    upstreamRepo,
    noto.items.map((item) => item.source_blob_oid),
  );
  for (const [index, item] of noto.items.entries()) {
    const bytes = upstreamBytes[index];
    assert.equal(gitBlobOID(bytes), item.source_blob_oid, `Noto upstream blob identity changed: ${item.source_path}`);
    assert.equal(bytes.length, item.source_bytes, `Noto upstream byte size changed: ${item.source_path}`);
    assert.equal(
      createHash('sha256').update(bytes).digest('hex'),
      item.source_sha256,
      `Noto upstream bytes do not match retained source: ${item.source_path}`,
    );
  }
}
const presets = JSON.parse(await readFile(resolve(root, 'control-panel/src/lib/profile-avatar-presets.json'), 'utf8'));
assert.deepEqual([...notoIDs].sort(), presets.map((preset) => preset.id).sort());
const tempNotoDir = await mkdtemp(join(tmpdir(), 'youeye-noto-'));
try {
  const outputPath = resolve(tempNotoDir, 'noto-avatar-inventory.json');
  await execFileAsync(process.execPath, [resolve(root, 'scripts/generate-noto-avatar-inventory.mjs'), outputPath]);
  assert.equal(await readFile(outputPath, 'utf8'), `${JSON.stringify(noto, null, 2)}\n`, 'Noto avatar inventory is stale');
} finally {
  await rm(tempNotoDir, { recursive: true, force: true });
}

const screenshots = JSON.parse(await readFile(resolve(root, 'legal/screenshot-inventory.json'), 'utf8'));
assert.equal(screenshots.schema, 'youeye.screenshot-inventory.v1');
assert.equal(screenshots.items.length, 32);
const screenshotPaths = new Set();
for (const screenshot of screenshots.items) {
  assert.equal(typeof screenshot.path, 'string', 'screenshot path must be a string');
  assert.ok(
    screenshot.path === 'screenshot.png'
      || /^docs\/assets\/screenshots\/[a-z0-9/-]+\.(?:gif|png)$/.test(screenshot.path),
    `invalid screenshot path: ${screenshot.path}`,
  );
  assert.equal(posix.normalize(screenshot.path), screenshot.path, `screenshot path is not normalized: ${screenshot.path}`);
  assert.ok(!screenshotPaths.has(screenshot.path), `duplicate screenshot path: ${screenshot.path}`);
  screenshotPaths.add(screenshot.path);
  assert.match(screenshot.sha256, /^[0-9a-f]{64}$/);
  assert.ok(Number.isSafeInteger(screenshot.bytes) && screenshot.bytes > 0, `invalid screenshot byte size: ${screenshot.path}`);
  assert.match(screenshot.introduced_commit, /^[0-9a-f]{40}$/);
  assert.equal(screenshot.source, 'YouEye product capture');
  assert.equal(screenshot.privacy_review, 'removed-from-public-source');
  await assert.rejects(
    lstat(resolve(root, screenshot.path)),
    (error) => error?.code === 'ENOENT',
    `removed screenshot is still present: ${screenshot.path}`,
  );
}
assert.ok(screenshotPaths.has('screenshot.png'), 'root screenshot removal is not inventoried');
if (verifyScreenshotHistory) {
  const commits = [...new Set(screenshots.items.map((screenshot) => screenshot.introduced_commit))];
  const commitObjects = await Promise.all(commits.map(async (commit) => {
    const { stdout } = await execFileAsync(
      'git',
      ['--no-replace-objects', '-C', root, 'rev-parse', '--verify', `${commit}^{commit}`],
      { env: gitEnvironment() },
    );
    assert.equal(stdout.trim(), commit, `screenshot introduction commit identity changed: ${commit}`);
    return commit;
  }));
  assert.deepEqual(commitObjects, commits);

  const screenshotObjectIDs = new Map();
  for (const commit of commits) {
    const records = screenshots.items.filter((screenshot) => screenshot.introduced_commit === commit);
    const entries = await gitEntries(root, commit, records.map((screenshot) => screenshot.path));
    for (const screenshot of records) {
      screenshotObjectIDs.set(`${commit}:${screenshot.path}`, entries.get(screenshot.path));
    }
  }
  const bytesByOID = new Map();
  const uniqueObjectIDs = [...new Set(screenshotObjectIDs.values())];
  const objectBytes = await readGitObjects(root, uniqueObjectIDs);
  for (const [index, oid] of uniqueObjectIDs.entries()) bytesByOID.set(oid, objectBytes[index]);

  for (const screenshot of screenshots.items) {
    const objectID = screenshotObjectIDs.get(`${screenshot.introduced_commit}:${screenshot.path}`);
    const bytes = bytesByOID.get(objectID);
    assert.equal(bytes.length, screenshot.bytes, `historical screenshot byte size changed: ${screenshot.path}`);
    assert.equal(
      createHash('sha256').update(bytes).digest('hex'),
      screenshot.sha256,
      `historical screenshot digest changed: ${screenshot.path}`,
    );
  }
}
const strictChecks = [];
if (verifyNotoUpstream) strictChecks.push('Noto upstream');
if (verifyScreenshotHistory) strictChecks.push('screenshot history');
console.log(`third-party asset registry tests passed${strictChecks.length > 0 ? ` with ${strictChecks.join(' and ')} verification` : ''}`);
