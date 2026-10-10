import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync,
  readFileSync, readdirSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { AppUpdateWorkspace, updateDigest } from '../src/lib/market/update-workspace';

const panel = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspaceModule = path.join(panel, 'src/lib/market/update-workspace.ts');
const limit = 128 * 1024 * 1024;
const secret = Buffer.from('postgres-password=fixture-secret\nCREATE TABLE private_data; user-record=42\n');

function temporary(work: (root: string) => void) {
  const root = mkdtempSync(path.join(tmpdir(), 'youeye-workspace-'));
  try { work(root); } finally { rmSync(root, { recursive: true, force: true }); }
}
function subprocess(source: string, args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', '-e', source, workspaceModule, ...args], {
    cwd: panel, timeout: 10_000, encoding: 'utf8',
  });
}

test('binary recovery payload survives a fresh process without plaintext in durable files', () => temporary(root => {
  const id = randomUUID();
  const workspace = new AppUpdateWorkspace(root, id);
  const payload = Buffer.concat([secret, Buffer.from([0, 255, 128, 0, 1])]);
  const digest = workspace.put('database.dump', payload);
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.equal(digest, updateDigest(readFileSync(path.join(workspace.directory, 'database.dump'))));
  for (const file of [path.join(root, 'recovery.key'), path.join(workspace.directory, 'database.dump')]) {
    assert.equal(lstatSync(file).mode & 0o777, 0o600);
    assert.equal(readFileSync(file).includes(secret), false);
  }
  for (const directory of [root, path.join(root, 'payloads'), workspace.directory]) {
    assert.equal(lstatSync(directory).mode & 0o777, 0o700);
  }
  assert.deepEqual(new AppUpdateWorkspace(root, id).get('database.dump', digest), payload);
  const result = subprocess(`
    const assert = require('node:assert/strict');
    const { AppUpdateWorkspace } = require(process.argv[1]);
    const workspace = new AppUpdateWorkspace(process.argv[2], process.argv[3]);
    assert.deepEqual(workspace.get('database.dump', process.argv[4]), Buffer.from(process.argv[5], 'base64'));
  `, [root, id, digest, payload.toString('base64')]);
  assert.equal(result.status, 0, result.stderr);
}));

test('empty and arbitrary binary payloads round trip; independent puts use fresh authenticated ciphertext', () => temporary(root => {
  const workspace = new AppUpdateWorkspace(root, randomUUID());
  for (const data of [Buffer.alloc(0), Buffer.from(Array.from({ length: 256 }, (_, i) => i))]) {
    const digest = workspace.put('binary', data);
    assert.deepEqual(workspace.get('binary', digest), data);
  }
  const first = workspace.put('binary', secret);
  const key = readFileSync(path.join(root, 'recovery.key'));
  const second = workspace.put('binary', secret);
  assert.notEqual(first, second);
  assert.throws(() => workspace.get('binary', first), /digest/);
  assert.deepEqual(workspace.get('binary', second), secret);
  assert.deepEqual(readFileSync(path.join(root, 'recovery.key')), key);
  assert.deepEqual(readdirSync(workspace.directory), ['binary']);
}));

for (const region of ['iv', 'body', 'tag'] as const) {
  test(`tampered ${region} fails both pinned digest and authenticated decryption`, () => temporary(root => {
    const workspace = new AppUpdateWorkspace(root, randomUUID());
    const digest = workspace.put('plan', secret);
    const file = path.join(workspace.directory, 'plan');
    const bytes = readFileSync(file);
    const index = region === 'iv' ? 0 : region === 'body' ? 12 : bytes.length - 1;
    bytes[index] ^= 0x80;
    writeFileSync(file, bytes);
    assert.throws(() => workspace.get('plan', digest));
    assert.throws(() => workspace.get('plan', updateDigest(bytes)));
    assert.throws(() => workspace.get('plan'));
  }));
}

test('truncation, appended bytes, missing payload and wrong hash fail closed', () => temporary(root => {
  const workspace = new AppUpdateWorkspace(root, randomUUID());
  const digest = workspace.put('plan', secret);
  const file = path.join(workspace.directory, 'plan');
  const original = readFileSync(file);
  assert.throws(() => workspace.get('missing', digest));
  assert.throws(() => workspace.get('plan', '0'.repeat(64)));
  for (const bytes of [Buffer.alloc(0), original.subarray(0, 27), original.subarray(0, -1), Buffer.concat([original, Buffer.from('suffix')])]) {
    writeFileSync(file, bytes);
    assert.throws(() => workspace.get('plan', digest));
    assert.throws(() => workspace.get('plan'));
  }
}));

test('ciphertext cannot be substituted under another reference, operation or encryption root', () => temporary(root => {
  const first = new AppUpdateWorkspace(root, randomUUID());
  const digest = first.put('metadata', secret);
  const source = path.join(first.directory, 'metadata');
  copyFileSync(source, path.join(first.directory, 'database'));
  assert.throws(() => first.get('database', digest));
  const other = new AppUpdateWorkspace(root, randomUUID());
  copyFileSync(source, path.join(other.directory, 'metadata'));
  assert.throws(() => other.get('metadata', digest));
  const differentKey = new AppUpdateWorkspace(path.join(root, 'other-root'), path.basename(first.directory));
  copyFileSync(source, path.join(differentKey.directory, 'metadata'));
  assert.throws(() => differentKey.get('metadata', digest));
  assert.deepEqual(first.get('metadata', digest), secret);
}));

test('replaced key cannot decrypt existing payloads and does not regenerate them', () => temporary(root => {
  const id = randomUUID();
  const workspace = new AppUpdateWorkspace(root, id);
  const digest = workspace.put('plan', secret);
  const file = path.join(workspace.directory, 'plan');
  const ciphertext = readFileSync(file);
  const keyFile = path.join(root, 'recovery.key');
  const original = readFileSync(keyFile);
  writeFileSync(keyFile, Buffer.alloc(32, 23));
  assert.throws(() => new AppUpdateWorkspace(root, id).get('plan', digest));
  assert.deepEqual(readFileSync(file), ciphertext);
  writeFileSync(keyFile, original);
  assert.deepEqual(new AppUpdateWorkspace(root, id).get('plan', digest), secret);
}));

test('missing key for retained payloads does not silently generate a replacement key', () => temporary(root => {
  const id = randomUUID();
  const workspace = new AppUpdateWorkspace(root, id);
  const digest = workspace.put('plan', secret);
  const file = path.join(workspace.directory, 'plan');
  const ciphertext = readFileSync(file);
  const keyFile = path.join(root, 'recovery.key');
  const original = readFileSync(keyFile);
  rmSync(keyFile);
  assert.throws(() => new AppUpdateWorkspace(root, id));
  assert.equal(existsSync(keyFile), false, 'retained recovery data must not be orphaned by key regeneration');
  assert.deepEqual(readFileSync(file), ciphertext);
  writeFileSync(keyFile, original, { mode: 0o600 });
  assert.deepEqual(new AppUpdateWorkspace(root, id).get('plan', digest), secret);
}));

for (const target of ['root', 'payloads', 'operation', 'key', 'payload'] as const) {
  test(`public ${target} permissions are refused without returning recovery plaintext`, () => temporary(root => {
    const id = randomUUID();
    const workspace = new AppUpdateWorkspace(root, id);
    const digest = workspace.put('plan', secret);
    const candidate = {
      root, payloads: path.join(root, 'payloads'), operation: workspace.directory,
      key: path.join(root, 'recovery.key'), payload: path.join(workspace.directory, 'plan'),
    }[target];
    const mode = lstatSync(candidate).mode & 0o777;
    chmodSync(candidate, target === 'key' || target === 'payload' ? 0o644 : 0o755);
    try {
      assert.throws(() => new AppUpdateWorkspace(root, id).get('plan', digest));
    } finally { chmodSync(candidate, mode); }
    assert.deepEqual(new AppUpdateWorkspace(root, id).get('plan', digest), secret);
  }));
}

for (const operation of ['get', 'put'] as const) {
  test(`existing workspace ${operation} refuses a substituted operation-directory symlink`, () => temporary(root => {
    const workspace = new AppUpdateWorkspace(root, randomUUID());
    const digest = workspace.put('plan', secret);
    const destination = path.join(root, 'outside-operation');
    renameSync(workspace.directory, destination);
    symlinkSync(destination, workspace.directory);
    const before = readFileSync(path.join(destination, 'plan'));
    assert.throws(() => operation === 'get' ? workspace.get('plan', digest) : workspace.put('plan', Buffer.from('replacement')));
    assert.equal(updateDigest(readFileSync(path.join(destination, 'plan'))), updateDigest(before),
      'failed access must not overwrite the symlink target');
  }));
}

for (const size of [0, 31, 33]) {
  test(`invalid recovery key length ${size} is refused and preserved for diagnosis`, () => temporary(root => {
    const key = path.join(root, 'recovery.key');
    writeFileSync(key, Buffer.alloc(size), { mode: 0o600 });
    assert.throws(() => new AppUpdateWorkspace(root, randomUUID()));
    assert.equal(lstatSync(key).size, size);
  }));
}

for (const target of ['root', 'payloads', 'operation', 'key', 'payload'] as const) {
  test(`symlinked ${target} is refused`, () => temporary(root => {
    const id = randomUUID();
    const workspace = new AppUpdateWorkspace(root, id);
    const digest = workspace.put('plan', secret);
    const candidate = {
      root: path.join(root, 'root-link'), payloads: path.join(root, 'payloads'),
      operation: workspace.directory, key: path.join(root, 'recovery.key'), payload: path.join(workspace.directory, 'plan'),
    }[target];
    if (target === 'root') {
      symlinkSync(root, candidate);
      assert.throws(() => new AppUpdateWorkspace(candidate, id));
    } else {
      const moved = path.join(root, `saved-${target}`);
      if (lstatSync(candidate).isDirectory()) {
        // Move outside the original pathname, then provide a symlink to the same bytes.
        renameSync(candidate, moved);
      } else {
        copyFileSync(candidate, moved);
        rmSync(candidate);
      }
      symlinkSync(moved, candidate);
      assert.throws(() => new AppUpdateWorkspace(root, id).get('plan', digest));
    }
  }));
}

for (const name of ['../escape', '/absolute', 'nested/file', '.pending-name', '', 'a'.repeat(129)]) {
  test(`unsafe payload reference ${JSON.stringify(name)} cannot read or write outside its operation`, () => temporary(root => {
    const workspace = new AppUpdateWorkspace(root, randomUUID());
    assert.throws(() => workspace.put(name, secret));
    assert.throws(() => workspace.get(name));
    assert.deepEqual(readdirSync(workspace.directory), []);
    assert.equal(existsSync(path.join(root, 'escape')), false);
  }));
}

for (const target of ['key', 'payload'] as const) {
  test(`FIFO ${target} rejects promptly rather than blocking a recovery process`, () => temporary(root => {
    const id = randomUUID();
    const workspace = new AppUpdateWorkspace(root, id);
    const digest = workspace.put('plan', secret);
    const file = target === 'key' ? path.join(root, 'recovery.key') : path.join(workspace.directory, 'plan');
    rmSync(file);
    const fifo = spawnSync('mkfifo', ['-m', '600', file], { encoding: 'utf8', timeout: 5000 });
    assert.equal(fifo.status, 0, fifo.stderr);
    const result = subprocess(`
      const assert = require('node:assert/strict');
      const { AppUpdateWorkspace } = require(process.argv[1]);
      assert.throws(() => new AppUpdateWorkspace(process.argv[2], process.argv[3]).get('plan', process.argv[4]));
    `, [root, id, digest]);
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.status, 0, result.stderr);
  }));
}

test('oversized payload is rejected before decryption', () => temporary(root => {
  const workspace = new AppUpdateWorkspace(root, randomUUID());
  workspace.put('plan', secret);
  truncateSync(path.join(workspace.directory, 'plan'), limit + 1);
  assert.throws(() => workspace.get('plan'), /oversized/i);
}));

test('pathname replacement cannot authorize an insecure already-open payload', () => temporary(root => {
  const id = randomUUID();
  const workspace = new AppUpdateWorkspace(root, id);
  const digest = workspace.put('plan', secret);
  const file = path.join(workspace.directory, 'plan');
  chmodSync(file, 0o644);
  const result = subprocess(`
    const fs = require('node:fs');
    const assert = require('node:assert/strict');
    const { AppUpdateWorkspace } = require(process.argv[1]);
    const workspace = new AppUpdateWorkspace(process.argv[2], process.argv[3]);
    const open = fs.openSync;
    let replaced = false;
    fs.openSync = (file, ...args) => {
      const fd = open(file, ...args);
      if (file === process.argv[4] && !replaced) {
        replaced = true;
        fs.renameSync(file, file + '.insecure');
        fs.writeFileSync(file, fs.readFileSync(file + '.insecure'), { mode: 0o600 });
      }
      return fd;
    };
    assert.throws(() => workspace.get('plan', process.argv[5]));
    assert.equal(replaced, true, 'pathname replacement did not execute');
  `, [root, id, file, digest]);
  assert.equal(result.status, 0, result.stderr);
}));

test('growth between metadata inspection and reading cannot bypass payload size limit', () => temporary(root => {
  const id = randomUUID();
  const workspace = new AppUpdateWorkspace(root, id);
  workspace.put('plan', secret);
  const file = path.join(workspace.directory, 'plan');
  const result = subprocess(`
    const fs = require('node:fs');
    const assert = require('node:assert/strict');
    const { AppUpdateWorkspace } = require(process.argv[1]);
    const workspace = new AppUpdateWorkspace(process.argv[2], process.argv[3]);
    let grew = false;
    // Trigger the same deterministic race with pathname or descriptor inspection.
    // No timing assumptions, source inspection or implementation text assertions.
    for (const method of ['lstatSync', 'fstatSync']) {
      const inspect = fs[method];
      fs[method] = (...args) => {
        const result = inspect(...args);
        if (!grew && result.isFile()) {
          grew = true;
          fs.truncateSync(process.argv[4], ${limit + 1});
        }
        return result;
      };
    }
    assert.throws(() => workspace.get('plan'), /oversized/i);
    assert.equal(grew, true, 'growth injection did not execute');
  `, [root, id, file]);
  assert.equal(result.status, 0, result.stderr);
}));

test('recovery key growth after metadata inspection is rejected', () => temporary(root => {
  const id = randomUUID();
  new AppUpdateWorkspace(root, id).put('plan', secret);
  const result = subprocess(`
    const fs = require('node:fs');
    const assert = require('node:assert/strict');
    const { AppUpdateWorkspace } = require(process.argv[1]);
    let grew = false;
    for (const method of ['lstatSync', 'fstatSync']) {
      const inspect = fs[method];
      fs[method] = (...args) => {
        const result = inspect(...args);
        if (!grew && result.isFile()) {
          grew = true;
          fs.truncateSync(process.argv[4], 33);
        }
        return result;
      };
    }
    assert.throws(() => new AppUpdateWorkspace(process.argv[2], process.argv[3]));
    assert.equal(grew, true, 'key growth injection did not execute');
  `, [root, id, path.join(root, 'recovery.key')]);
  assert.equal(result.status, 0, result.stderr);
}));
