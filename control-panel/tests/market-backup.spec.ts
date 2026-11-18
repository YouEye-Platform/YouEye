/**
 * Plan 11 C11: the core backup carries the Market sources the owner added (`market-sources.json`) and the apps added
 * by URL (`state/direct-market-apps.json`), and a full restore puts them back. What the markets hold
 * (`/var/lib/youeye/markets/**`) is rebuilt by reading the markets again, never backed up. A backup made before this
 * (no `marketFiles` in its record) restores as before.
 */
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as jsonStore from '../src/lib/storage/json-store';
import { load } from './fixtures/market-world';
import {
  MARKET_BACKUP_FILES, marketFilePath, readMarketStateFromBackup, restoreMarketState, stageMarketState,
} from '../src/lib/backup/market-state';

const root = process.env.CONTROL_PANEL_ROOT || path.join(import.meta.dirname, '..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');

const SOURCES = JSON.stringify({ active_sources: [{ id: 'official', enabled: true },
  { id: 'friend', name: 'Friend', url: 'https://markets.example.org/friend/', enabled: true, priority: 1, accepted_at: '2026-11-18T10:00:00.000Z' }] });
const DIRECT = JSON.stringify({ schemaVersion: 1, entries: { 'direct:abc': { sourceId: 'direct:abc', manifestUrl: 'https://apps.example.org/demo/youeye-app.yaml' } } });

function folders() {
  const base = mkdtempSync(path.join(tmpdir(), 'youeye-market-backup-'));
  const data = path.join(base, 'data');
  const staging = path.join(base, 'staging');
  mkdirSync(path.join(data, 'state'), { recursive: true });
  mkdirSync(staging, { recursive: true });
  return { base, data, staging, done: () => rmSync(base, { recursive: true, force: true }) };
}

test('the Market files are where the Market keeps them', () => {
  assert.equal(marketFilePath('market-sources.json'), '/var/lib/youeye/market-sources.json');
  assert.equal(marketFilePath('direct-market-apps.json'), '/var/lib/youeye/state/direct-market-apps.json');
  assert.match(read('src/lib/market/source.ts'), /path\.join\(marketStateDir\(\), 'market-sources\.json'\)/);
  assert.match(read('src/lib/market/direct-apps.ts'), /statePath\('direct-market-apps\.json'\)/);
  assert.match(read('src/lib/storage/json-store.ts'), /const STATE_DIR = '\/var\/lib\/youeye\/state'/);
});

test('a box that never added a source or an app backs up no Market file, and says so', async () => {
  const f = folders();
  try {
    assert.deepEqual(await stageMarketState(f.staging, f.data), []);
    assert.equal(existsSync(path.join(f.staging, 'market')), false);
  } finally { f.done(); }
});

test('the Market files are copied into the backup (0600), byte for byte', async () => {
  const f = folders();
  try {
    writeFileSync(path.join(f.data, 'market-sources.json'), SOURCES);
    writeFileSync(path.join(f.data, 'state', 'direct-market-apps.json'), DIRECT);
    // What the markets hold is never part of it.
    mkdirSync(path.join(f.data, 'markets', 'friend', 'h', 'index'), { recursive: true });
    writeFileSync(path.join(f.data, 'markets', 'friend', 'state.json'), '{}');
    assert.deepEqual(await stageMarketState(f.staging, f.data), ['market-sources.json', 'direct-market-apps.json']);
    assert.equal(readFileSync(path.join(f.staging, 'market', 'market-sources.json'), 'utf8'), SOURCES);
    assert.equal(readFileSync(path.join(f.staging, 'market', 'direct-market-apps.json'), 'utf8'), DIRECT);
    assert.equal(statSync(path.join(f.staging, 'market', 'market-sources.json')).mode & 0o777, 0o600);
    assert.equal(existsSync(path.join(f.staging, 'markets')), false);

    // Only one of them: only that one.
    const g = folders();
    try {
      writeFileSync(path.join(g.data, 'state', 'direct-market-apps.json'), DIRECT);
      assert.deepEqual(await stageMarketState(g.staging, g.data), ['direct-market-apps.json']);
    } finally { g.done(); }
  } finally { f.done(); }
});

test('a Market file that is not a plain file is refused', async () => {
  const f = folders();
  try {
    writeFileSync(path.join(f.base, 'elsewhere.json'), SOURCES);
    symlinkSync(path.join(f.base, 'elsewhere.json'), path.join(f.data, 'market-sources.json'));
    await assert.rejects(stageMarketState(f.staging, f.data), /not a plain file/);
  } finally { f.done(); }
});

test('a backup’s Market files are checked before a restore changes anything', async () => {
  const f = folders();
  try {
    // Made before Market files were backed up: nothing to restore, the target keeps its own.
    assert.equal(await readMarketStateFromBackup(f.staging, undefined), null);
    for (const recorded of [null, 'market-sources.json', ['market-sources.json', 'market-sources.json'], ['../config.yaml'], [1]]) {
      await assert.rejects(readMarketStateFromBackup(f.staging, recorded), /invalid list of Market files/, JSON.stringify(recorded));
    }
    await assert.rejects(readMarketStateFromBackup(f.staging, ['market-sources.json']), /missing its Market file/);
    mkdirSync(path.join(f.staging, 'market'));
    writeFileSync(path.join(f.staging, 'market', 'market-sources.json'), 'not json');
    await assert.rejects(readMarketStateFromBackup(f.staging, ['market-sources.json']), /not valid/);
    writeFileSync(path.join(f.staging, 'market', 'market-sources.json'), '[]');
    await assert.rejects(readMarketStateFromBackup(f.staging, ['market-sources.json']), /not valid/);
    writeFileSync(path.join(f.staging, 'market', 'market-sources.json'), SOURCES);
    const state = await readMarketStateFromBackup(f.staging, ['market-sources.json']);
    assert.deepEqual(state!.files.map((file) => [file.name, file.bytes.toString('utf8')]), [['market-sources.json', SOURCES]]);
    assert.deepEqual(await readMarketStateFromBackup(f.staging, []), { files: [] });
  } finally { f.done(); }
});

test('a backup whose Added-app store is not that store is refused before anything changes', async () => {
  const f = folders();
  try {
    mkdirSync(path.join(f.staging, 'market'));
    const file = path.join(f.staging, 'market', 'direct-market-apps.json');
    for (const bad of ['{}', '{"schemaVersion":1}', '{"entries":{}}', '{"schemaVersion":2,"entries":{}}',
      '{"schemaVersion":1,"entries":[]}', '{"schemaVersion":1,"entries":{"direct:abc":"x"}}']) {
      writeFileSync(file, bad);
      await assert.rejects(readMarketStateFromBackup(f.staging, ['direct-market-apps.json']), /direct-market-apps\.json is not valid/, bad);
    }
    for (const good of [DIRECT, '{"schemaVersion":1,"entries":{}}']) {
      writeFileSync(file, good);
      const state = await readMarketStateFromBackup(f.staging, ['direct-market-apps.json']);
      assert.equal(state!.files[0].bytes.toString('utf8'), good);
    }
  } finally { f.done(); }
});

test('an Added-app store without entries reads as empty instead of failing the catalog', async () => {
  const f = folders();
  try {
    const storePath = path.join(f.data, 'state', 'direct-market-apps.json');
    const directApps = load('src/lib/market/direct-apps.ts', {
      '@/lib/storage/json-store': { ...jsonStore, statePath: () => storePath },
    });
    for (const content of ['{}', 'null', '[]', '{"schemaVersion":1,"entries":null}']) {
      writeFileSync(storePath, content);
      assert.deepEqual(await directApps.listDirectMarketApps(), [], content);
      assert.equal(await directApps.getDirectMarketApp('direct:abc'), null, content);
      assert.equal(await directApps.removeDirectMarketApp('direct:abc'), false, content);
    }
  } finally { f.done(); }
});

test('a backup holds only Market files a restore takes: an Added-app store without apps is backed up as the empty store', async () => {
  const f = folders();
  try {
    const live = path.join(f.data, 'state', 'direct-market-apps.json');
    const staged = path.join(f.staging, 'market', 'direct-market-apps.json');
    // The empty store as the Market's writer makes it (its last app removed).
    const directApps = load('src/lib/market/direct-apps.ts', {
      '@/lib/storage/json-store': { ...jsonStore, statePath: () => live },
    });
    writeFileSync(live, DIRECT);
    assert.equal(await directApps.removeDirectMarketApp('direct:abc'), true);
    const empty = readFileSync(live, 'utf8');

    // What the Market reads as no apps: backed up as the empty store, which a restore takes.
    for (const content of ['{}', 'null', '[]', '"x"', '{"schemaVersion":1,"entries":null}', '{"entries":{}}', '{"schemaVersion":2,"entries":[]}']) {
      writeFileSync(live, content);
      rmSync(path.join(f.staging, 'market'), { recursive: true, force: true });
      assert.deepEqual(await stageMarketState(f.staging, f.data), ['direct-market-apps.json'], content);
      assert.equal(readFileSync(staged, 'utf8'), empty, content);
      const state = await readMarketStateFromBackup(f.staging, ['direct-market-apps.json']);
      assert.equal(state!.files[0].bytes.toString('utf8'), empty, content);
    }
    // A valid store is copied byte for byte, an empty one included.
    for (const good of [DIRECT, '{"schemaVersion":1,"entries":{}}']) {
      writeFileSync(live, good);
      await stageMarketState(f.staging, f.data);
      assert.equal(readFileSync(staged, 'utf8'), good);
    }
    // A file with apps the restore would refuse fails the backup, saying which file and why.
    for (const bad of ['not json', '{"schemaVersion":1,"entries":{"direct:abc":"x"}}', `{"entries":${JSON.stringify(JSON.parse(DIRECT).entries)}}`]) {
      writeFileSync(live, bad);
      await assert.rejects(stageMarketState(f.staging, f.data), /Refusing to back up state\/direct-market-apps\.json: it is not/, bad);
    }
    rmSync(live);
    writeFileSync(path.join(f.data, 'market-sources.json'), '[]');
    await assert.rejects(stageMarketState(f.staging, f.data), /Refusing to back up market-sources\.json: it is not a JSON object/);
  } finally { f.done(); }
});

test('a restore puts the backup’s Market files in place and removes the ones it does not hold', async () => {
  const f = folders();
  try {
    writeFileSync(path.join(f.data, 'market-sources.json'), '{"active_sources":[]}');
    writeFileSync(path.join(f.data, 'state', 'direct-market-apps.json'), '{"schemaVersion":1,"entries":{}}');
    await restoreMarketState({ files: [{ name: 'market-sources.json', bytes: Buffer.from(SOURCES) }] }, f.data);
    assert.equal(readFileSync(path.join(f.data, 'market-sources.json'), 'utf8'), SOURCES);
    assert.equal(statSync(path.join(f.data, 'market-sources.json')).mode & 0o777, 0o600);
    assert.equal(existsSync(path.join(f.data, 'state', 'direct-market-apps.json')), false, 'the backup’s box had no Added apps');

    // Onto a fresh box (no state folder yet), both.
    const g = folders();
    try {
      rmSync(path.join(g.data, 'state'), { recursive: true });
      chmodSync(g.data, 0o755);
      await restoreMarketState({ files: [
        { name: 'market-sources.json', bytes: Buffer.from(SOURCES) },
        { name: 'direct-market-apps.json', bytes: Buffer.from(DIRECT) },
      ] }, g.data);
      assert.equal(readFileSync(path.join(g.data, 'state', 'direct-market-apps.json'), 'utf8'), DIRECT);
      // Restoring the same backup twice gives the same result (the restore step may be repeated).
      await restoreMarketState({ files: [{ name: 'market-sources.json', bytes: Buffer.from(SOURCES) }, { name: 'direct-market-apps.json', bytes: Buffer.from(DIRECT) }] }, g.data);
      assert.equal(readFileSync(path.join(g.data, 'market-sources.json'), 'utf8'), SOURCES);
    } finally { g.done(); }
  } finally { f.done(); }
  assert.deepEqual(Object.keys(MARKET_BACKUP_FILES), ['market-sources.json', 'direct-market-apps.json']);
});

test('the core backup records its Market files and a full restore uses them; markets are not backed up', () => {
  const core = read('src/lib/backup/core-backup.ts');
  assert.match(core, /marketFiles = await stageMarketState\(stagingDir, YOUEYE_DATA_DIR\)/);
  assert.match(core, /infraContainers: INFRA_CONTAINERS,\s*\/\/[^\n]*\n\s*marketFiles,/);
  const volumes = core.slice(core.indexOf('const INFRA_VOLUME_PATHS'), core.indexOf('];', core.indexOf('const INFRA_VOLUME_PATHS')));
  assert.doesNotMatch(volumes, /markets|market-sources/);

  const restore = read('src/lib/backup/full-restore.ts');
  // Read and checked with the other mandatory inputs, before the live server changes; skipped for older backups.
  const check = restore.indexOf('readMarketStateFromBackup(coreStagingDir, coreMeta.marketFiles)');
  assert.ok(check > 0 && check < restore.indexOf("runStep('remove-current-apps'"));
  assert.match(restore, /coreMeta\.marketFiles === undefined \? null/);
  // Put back before the apps are restored, then the stores of sources the list no longer names go.
  const step = restore.indexOf("runStep('restore-market-sources', 'replace'");
  assert.ok(step > restore.indexOf("runStep('reconcile-apps'") && step < restore.indexOf('`restore-app:${appId}`'));
  assert.match(restore, /removeMarketStoresExcept\(\(await getConfiguredMarketSources\(\)\)\.map\(source => source\.id\)\)/);
});

test('Spine archives the staging folder as it is: the Market files need nothing on its side', () => {
  const runner = read('../spine/internal/backup/runner.go');
  assert.match(runner, /exec\.Command\("tar", "--numeric-owner", "-cf", tarPath, "-C", cfg\.StagingDir, "\."\)/);
  for (const file of ['runner.go', 'restore.go', 'volumes.go']) {
    assert.doesNotMatch(read(`../spine/internal/backup/${file}`), /installed-apps\.json|market-sources|direct-market-apps/);
  }
});
