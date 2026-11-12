import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { acceptCatalogRelease, readAcceptedCatalog, readCatalogTar, refreshOfficialCatalog, verifyCatalogFile, verifyCatalogSnapshot } from '../src/lib/market/catalog-release';
import { buildMarketRawURL, officialMarketSource, parseMarketRepoURL } from '../src/lib/market/source';
import { verifyProductRelease } from '../src/lib/releases/product-release';
import { fakeReleaseHost, productFixture, sha } from './fixtures/release-fixtures';

const marketRepo = 'https://git.example.test/owner/YE-AppMarket';
const longPath = `apps/${'very-long-directory-name-'.repeat(5)}/youeye-app.yaml`;

async function catalogBuild(format: 'pax' | 'gnu' | 'ustar', files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'youeye-catalog-tar-'));
  try {
    for (const [path, body] of Object.entries(files)) {
      await mkdir(join(root, 'tree', dirname(path)), { recursive: true });
      await writeFile(join(root, 'tree', path), body);
    }
    execFileSync('tar', [`--format=${format}`, '-cf', join(root, 'catalog.tar'), '-C', join(root, 'tree'), ...Object.keys(files)]);
    return await readFile(join(root, 'catalog.tar'));
  } finally { await rm(root, { recursive: true, force: true }); }
}

function snapshotOf(files: Record<string, string>) {
  return Buffer.from(JSON.stringify({ apiVersion: 'youeye.market/catalog-snapshot/v1', catalog: { sha256: `sha256:${sha(files['catalog.yaml'])}` },
    content: { files: Object.entries(files).map(([path, body]) => ({ path, sha256: `sha256:${sha(body)}` })) } }));
}

function marketRelease(version: string, sequence: number, snapshot: Buffer, tar: Buffer, build?: string) {
  const f = productFixture('market', version, marketRepo, { 'catalog-snapshot.json': snapshot, 'catalog.tar': tar }, { kind: 'catalog', primary: 'catalog.tar', sequence, contract: snapshot, build });
  return { f, selected: verifyProductRelease(f.raw, { product: 'market', repository: marketRepo, tag: f.tag }) };
}

const files = { 'catalog.yaml': 'apps:\n  - id: notes\n    integration: native\n', 'apps/memos/youeye-app.yaml': 'id: memos\n', 'apps/memos/icon.svg': '<svg/>', [longPath]: 'id: long\n' };

test('catalog.tar holds exactly the snapshot files, each hash-checked', async () => {
  for (const format of ['pax', 'gnu'] as const) {
    const tar = await catalogBuild(format, files);
    const snapshot = snapshotOf(files);
    const { selected } = marketRelease('0.6.1-dev.1', 1, snapshot, tar);
    const parsed = readCatalogTar(tar, verifyCatalogSnapshot(selected, snapshot));
    assert.deepEqual([...parsed.keys()].sort(), Object.keys(files).sort(), format);
    assert.equal(parsed.get(longPath)?.toString(), 'id: long\n');
    // A missing, extra or changed file is refused.
    const { [longPath]: _dropped, ...fewer } = files;
    assert.throws(() => readCatalogTar(tar, verifyCatalogSnapshot(marketRelease('0.6.1-dev.1', 1, snapshotOf(fewer), tar).selected, snapshotOf(fewer))), /differs/);
    const changed = await catalogBuild(format, { ...files, 'apps/memos/youeye-app.yaml': 'id: evil\n' });
    assert.throws(() => readCatalogTar(changed, verifyCatalogSnapshot(selected, snapshot)), /differs/);
    const more = await catalogBuild(format, { ...files, 'extra.yaml': 'x' });
    assert.throws(() => readCatalogTar(more, verifyCatalogSnapshot(selected, snapshot)), /differs/);
  }
});

test('the official Market follows the channel index and keeps its accepted catalog offline', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'youeye-market-release-'));
  const saved = globalThis.fetch;
  try {
    const tar = await catalogBuild('pax', files);
    const snapshot = snapshotOf(files);
    const one = marketRelease('0.6.1-dev.1', 10, snapshot, tar);
    const host = fakeReleaseHost(new Map([
      [`${marketRepo}/releases/download/${one.f.tag}/catalog-snapshot.json`, snapshot],
      [`${marketRepo}/releases/download/${one.f.tag}/catalog.tar`, tar],
    ]));
    globalThis.fetch = host.fetch;
    assert.equal(await readAcceptedCatalog(directory), null);
    const accepted = await refreshOfficialCatalog({ directory, resolve: async () => one.selected });
    assert.equal(accepted.selected.release.version, '0.6.1-dev.1');
    assert.equal(accepted.files.get('catalog.yaml')?.toString(), files['catalog.yaml']);
    assert.ok(host.requests.every((url) => url.startsWith(`${marketRepo}/releases/download/`)), host.requests.join('\n'));
    verifyCatalogFile(accepted.snapshot, 'apps/memos/youeye-app.yaml', files['apps/memos/youeye-app.yaml']);
    assert.throws(() => verifyCatalogFile(accepted.snapshot, 'apps/memos/youeye-app.yaml', 'changed'), /differs/);
    assert.deepEqual((await readdir(directory)).filter((n) => n.endsWith('.tar')), [`catalog-${sha(tar)}.tar`]);

    // Same release again: nothing is downloaded. Offline: the accepted catalog stays.
    const before = host.requests.length;
    assert.equal((await refreshOfficialCatalog({ directory, resolve: async () => one.selected })).selected.manifestSHA256, one.selected.manifestSHA256);
    assert.equal((await refreshOfficialCatalog({ directory, resolve: async () => null })).selected.manifestSHA256, one.selected.manifestSHA256);
    assert.equal(host.requests.length, before);

    // An older catalog on the channel is never adopted (the box waits).
    const older = marketRelease('0.6.0-dev.9', 5, snapshot, tar);
    await assert.rejects(refreshOfficialCatalog({ directory, resolve: async () => older.selected }), /older market build/);
    await assert.rejects(acceptCatalogRelease(older.selected, snapshot, tar, directory), /older/);
    // An older build under a stable-looking name is still older.
    const renamedOlder = marketRelease('0.6.1', 50, snapshot, tar, '0.6.0-dev.9');
    await assert.rejects(acceptCatalogRelease(renamedOlder.selected, snapshot, tar, directory), /older market build/);

    // The accepted build promoted under another name is adopted.
    const promoted = marketRelease('0.6.1-alpha.1', 10, snapshot, tar, '0.6.1-dev.1');
    await acceptCatalogRelease(promoted.selected, snapshot, tar, directory);
    assert.equal((await readAcceptedCatalog(directory))?.selected.release.version, '0.6.1-alpha.1');
    assert.equal((await readAcceptedCatalog(directory))?.floors.market.build, '0.6.1-dev.1');

    // A newer release replaces the accepted tar.
    const next = { ...files, 'catalog.yaml': `${files['catalog.yaml']}# next\n` };
    const nextTar = await catalogBuild('gnu', next), nextSnapshot = snapshotOf(next);
    const two = marketRelease('0.6.1-dev.2', 11, nextSnapshot, nextTar);
    await acceptCatalogRelease(two.selected, nextSnapshot, nextTar, directory);
    assert.equal((await readAcceptedCatalog(directory))?.selected.release.version, '0.6.1-dev.2');
    assert.deepEqual((await readdir(directory)).filter((n) => n.endsWith('.tar')), [`catalog-${sha(nextTar)}.tar`]);
    await assert.rejects(acceptCatalogRelease(two.selected, nextSnapshot, tar, directory), /differs from its release digest/);
  } finally {
    globalThis.fetch = saved;
    await rm(directory, { recursive: true, force: true });
  }
});

test('custom Market sources read raw files from their branch, never a forge API', () => {
  assert.equal(officialMarketSource().kind, 'channel');
  assert.throws(() => buildMarketRawURL(officialMarketSource(), 'a', 'b', 'catalog.yaml', 'main'), /catalog release/);
  const github = parseMarketRepoURL('https://github.com/example/Community-Market', { branch: 'main' });
  assert.equal(buildMarketRawURL(github, 'example', 'Community-Market', 'apps/x/youeye-app.yaml', 'main'),
    'https://raw.githubusercontent.com/example/Community-Market/main/apps/x/youeye-app.yaml');
  const forgejo = parseMarketRepoURL('https://forge.example.test/team/Market', { branch: 'release/one' });
  assert.equal(buildMarketRawURL(forgejo, 'team', 'Market', 'catalog.yaml', forgejo.branch),
    'https://forge.example.test/team/Market/raw/branch/release/one/catalog.yaml');
  assert.throws(() => parseMarketRepoURL('http://forge.example.test/team/Market'), /https/);
});
