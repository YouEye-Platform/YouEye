// A native Market app's package (YE-142): the box installs exactly the `standalone.tar` its manifest pins by URL,
// SHA-256 and size (`source.package`), from any market, by the release-download rules.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { MarketNativeArtifactPolicyError, nativePackageOf, stageMarketNativeArtifacts } from '../src/lib/market/native-artifact';
import { downloadReleaseFileTo } from '../src/lib/releases/channel-index';
import { appFixture, marketNativeFixture, nativeFixture } from './fixtures/app-format';

const execFileAsync = promisify(execFile);
const URL_OF_PACKAGE = 'https://packages.example.org/journal/v1.2.0/standalone.tar';

async function packageFile(t: test.TestContext, files: Record<string, string> = { 'server.js': 'console.log("ready")\n' }) {
  const root = await mkdtemp(join(tmpdir(), 'youeye-native-package-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const payload = join(root, 'payload');
  await mkdir(payload);
  for (const [name, text] of Object.entries(files)) await writeFile(join(payload, name), text);
  const archive = join(root, 'standalone.tar');
  await execFileAsync('tar', ['-cf', archive, '-C', payload, '.']);
  const bytes = await readFile(archive);
  return { archive, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
}

/** The download as the stager calls it, serving one local file for one URL (and recording every request). */
function fromDisk(served: Record<string, string>) {
  const asked: Array<{ url: string; limit: number }> = [];
  const download: typeof downloadReleaseFileTo = async (url, path, limit) => {
    asked.push({ url, limit });
    if (!served[url]) throw new Error(`Release file not found: ${url}`);
    await copyFile(served[url], path);
    const bytes = await readFile(path);
    return { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  };
  return { download, asked };
}

const journal = (pkg: { sha256: string; size: number }) =>
  marketNativeFixture({ id: 'journal', version: '1.2.0', source: { node: '24', package: { url: URL_OF_PACKAGE, sha256: pkg.sha256, size: pkg.size } } });

test('the package a manifest pins is downloaded from its URL, checked by size and SHA-256, and recorded as manifest-verified', async (t) => {
  const pkg = await packageFile(t);
  const manifest = journal(pkg);
  assert.deepEqual(nativePackageOf(manifest), { url: URL_OF_PACKAGE, sha256: pkg.sha256, size: pkg.size });
  const { download, asked } = fromDisk({ [URL_OF_PACKAGE]: pkg.archive });
  const staged = await stageMarketNativeArtifacts(manifest, { appId: 'journal' }, { download });
  try {
    const artifact = staged.byContainerName.get('main')!;
    assert.deepEqual(asked, [{ url: URL_OF_PACKAGE, limit: pkg.size }], 'one download, limited to the pinned size');
    assert.deepEqual({ ...artifact, path: undefined }, {
      containerName: 'main', path: undefined, tag: '1.2.0', version: '1.2.0', sourceRepo: URL_OF_PACKAGE, artifactName: 'standalone.tar',
      artifactSHA256: pkg.sha256, artifactBytes: pkg.size, verification: { status: 'manifest' },
    });
    assert.equal(artifact.productRelease, undefined, 'a Market app has no product release');
    assert.deepEqual(await readFile(artifact.path), await readFile(pkg.archive));
  } finally {
    await staged.cleanup();
  }
});

test('another file at the URL, a package over its size, or a package without server.js is refused before anything is deployed', async (t) => {
  const pkg = await packageFile(t);
  const other = await packageFile(t, { 'server.js': 'console.log("someone else")\n' });
  const { download } = fromDisk({ [URL_OF_PACKAGE]: other.archive });
  // The host serves other bytes than the manifest pinned: refused, whatever market named it.
  await assert.rejects(stageMarketNativeArtifacts(journal({ sha256: pkg.sha256, size: other.size }), { appId: 'journal' }, { download }),
    (error: unknown) => error instanceof MarketNativeArtifactPolicyError && /is not the one the manifest names \(size or SHA-256 differs\)/.test(error.message));
  await assert.rejects(stageMarketNativeArtifacts(journal({ sha256: other.sha256, size: other.size - 1 }), { appId: 'journal' }, { download }),
    /is not the one the manifest names/);
  // The real download stops at the pinned size (a host that sends more is cut off).
  const big = (async () => new Response(Buffer.alloc(other.size + 10), { status: 200 })) as typeof fetch;
  const real: typeof downloadReleaseFileTo = (url, path, limit) => downloadReleaseFileTo(url, path, limit, big);
  await assert.rejects(stageMarketNativeArtifacts(journal({ sha256: other.sha256, size: other.size }), { appId: 'journal' }, { download: real }),
    /could not be downloaded from .*exceeds/);
  // A package that is no app tree.
  const empty = await packageFile(t, { 'index.js': '1\n' });
  await assert.rejects(stageMarketNativeArtifacts(journal(empty), { appId: 'journal' }, { download: fromDisk({ [URL_OF_PACKAGE]: empty.archive }).download }),
    /App package is missing server\.js/);
  // A missing file is a download failure with its reason.
  await assert.rejects(stageMarketNativeArtifacts(journal(pkg), { appId: 'journal' }, { download: fromDisk({}).download }),
    /could not be downloaded from https:\/\/packages\.example\.org\/journal\/v1\.2\.0\/standalone\.tar: Release file not found/);
});

test('a manifest without a package (a frozen copy from before 0.6.20) cannot be installed from; a container app stages nothing', async () => {
  const frozen = nativeFixture({ id: 'notes', version: '0.6.4' });
  assert.equal(nativePackageOf(frozen), null);
  await assert.rejects(stageMarketNativeArtifacts(frozen, { appId: 'notes' }, { download: fromDisk({}).download }),
    /notes 0\.6\.4 names no package \(source\.package\); update YouEye's Market first, then try again/);
  await assert.rejects(stageMarketNativeArtifacts(journal({ sha256: 'a'.repeat(64), size: 10 }), { appId: 'other' }),
    /belongs to another app/);
  const container = await stageMarketNativeArtifacts(appFixture(), { appId: 'demo' });
  assert.equal(container.byContainerName.size, 0);
  // A restore that brings the runtime back skips its container: nothing is downloaded.
  const skipped = await stageMarketNativeArtifacts(journal({ sha256: 'a'.repeat(64), size: 10 }), { appId: 'journal' },
    { skipContainerNames: ['main'], download: fromDisk({}).download });
  assert.equal(skipped.byContainerName.size, 0);
});
