import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  readInstallMetadataAtBaseForTest,
  removeInstallMetadataRecordAtBaseForTest,
} from '../src/lib/market/metadata';

async function writeMetadata(baseDir: string, appId: string, mode = 0o600): Promise<string> {
  const directory = path.join(baseDir, `app-${appId}`);
  await mkdir(directory, { mode: 0o700 });
  const file = path.join(directory, 'install.json');
  await writeFile(file, `${JSON.stringify({ appId, containers: [] })}\n`, { mode });
  await chmod(file, mode);
  return directory;
}

test('root-owned legacy 0777 metadata directory is tightened before reading', async () => {
  const baseDir = await mkdtemp(path.join(tmpdir(), 'youeye-market-metadata-'));
  try {
    const directory = await writeMetadata(baseDir, 'session-legacy');
    await chmod(directory, 0o777);

    const metadata = await readInstallMetadataAtBaseForTest('session-legacy', baseDir);
    assert.equal(metadata?.appId, 'session-legacy');
    assert.equal((await lstat(directory)).mode & 0o777, 0o700);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test('legacy repair still rejects an unsafe metadata file', async () => {
  const baseDir = await mkdtemp(path.join(tmpdir(), 'youeye-market-metadata-'));
  try {
    const directory = await writeMetadata(baseDir, 'session-unsafe-file', 0o644);
    await chmod(directory, 0o777);

    await assert.rejects(
      readInstallMetadataAtBaseForTest('session-unsafe-file', baseDir),
      /corrupt or insecure/,
    );
    assert.equal((await lstat(directory)).mode & 0o777, 0o700);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test('metadata symlinks remain rejected', async () => {
  const baseDir = await mkdtemp(path.join(tmpdir(), 'youeye-market-metadata-'));
  try {
    const directory = path.join(baseDir, 'app-session-symlink');
    await mkdir(directory, { mode: 0o700 });
    const target = path.join(baseDir, 'target.json');
    await writeFile(target, `${JSON.stringify({ appId: 'session-symlink', containers: [] })}\n`, { mode: 0o600 });
    await symlink(target, path.join(directory, 'install.json'));

    await assert.rejects(
      readInstallMetadataAtBaseForTest('session-symlink', baseDir),
      /corrupt or insecure/,
    );
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test('record-only cleanup preserves colocated secrets and volume data', async () => {
  const baseDir = await mkdtemp(path.join(tmpdir(), 'youeye-market-metadata-'));
  try {
    const directory = await writeMetadata(baseDir, 'session-restore');
    const secret = path.join(directory, '.db_password');
    const data = path.join(directory, 'data', 'memos.db');
    await writeFile(secret, 'protected\n', { mode: 0o600 });
    await mkdir(path.dirname(data), { recursive: true });
    await writeFile(data, 'restored-data\n', { mode: 0o600 });

    await removeInstallMetadataRecordAtBaseForTest('session-restore', baseDir);

    await assert.rejects(lstat(path.join(directory, 'install.json')), { code: 'ENOENT' });
    assert.equal((await lstat(secret)).isFile(), true);
    assert.equal((await lstat(data)).isFile(), true);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});
