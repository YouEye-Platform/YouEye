import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const modulePath = path.resolve('src/lib/market/installed-apps.ts');

async function temporary(work: (directory: string) => Promise<void>) {
  const directory = mkdtempSync(path.join(tmpdir(), 'youeye-installed-concurrency-'));
  try { await work(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
}

function child(directory: string, script: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '-e', `
      const apps = require(${JSON.stringify(modulePath)});
      (async () => { ${script} })().catch(error => { console.error(error); process.exit(1); });
    `], {
      env: { ...process.env, YOUEYE_INSTALLED_APPS_PATH: path.join(directory, 'installed-apps.json'),
        YOUEYE_APP_UPDATE_JOURNAL_DIR: path.join(directory, 'journal') },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', bytes => { stderr += bytes; });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0 && !signal) resolve();
      else reject(new Error(stderr || `Child exited ${code}/${signal}`));
    });
  });
}

function readStore(directory: string) {
  return JSON.parse(readFileSync(path.join(directory, 'installed-apps.json'), 'utf8'));
}

test('cross-process app writes retain unique IDs and concurrent scoped mutations', () =>
  temporary(async directory => {
    await Promise.all(Array.from({ length: 4 }, (_, worker) => child(directory, `
      for (let i = 0; i < 5; i++) {
        const appId = 'app-${worker}-' + i;
        await apps.upsertInstalledApp({ appId, type: 'market', installedVersion: '1.0.0', subdomain: appId });
        await Promise.all([
          apps.updateForwardAuthEnabled(appId, true),
          apps.updateHealthStatus(appId, 'unhealthy', { healthDetail: 'new health decision' }),
          apps.updateInstalledVersion(appId, '2.0.0'),
        ]);
      }
    `)));
    const store = readStore(directory);
    const apps = Object.values(store.apps) as Array<Record<string, unknown>>;
    assert.equal(apps.length, 20);
    assert.equal(new Set(apps.map(app => app.id)).size, 20);
    assert.equal(store.nextId, 21);
    for (const app of apps) {
      assert.equal(app.installedVersion, '2.0.0');
      assert.equal(app.forwardAuthEnabled, true);
      assert.equal(app.healthStatus, 'unhealthy');
      assert.equal(app.healthDetail, 'new health decision');
    }
  }));

test('appliance 0755 State supports concurrent writes with a private stable lock directory', () =>
  temporary(async directory => {
    chmodSync(directory, 0o755);
    await Promise.all(['first', 'second'].map(appId => child(directory, `
      await apps.upsertInstalledApp({ appId: '${appId}', type: 'market', installedVersion: '1.0.0', subdomain: '${appId}' });
    `)));
    assert.deepEqual(Object.keys(readStore(directory).apps).sort(), ['first', 'second']);
    assert.equal(statSync(directory).mode & 0o777, 0o755);
    assert.equal(statSync(path.join(directory, '.installed-apps-lock')).mode & 0o777, 0o700);
    assert.equal(statSync(path.join(directory, '.installed-apps-lock/store.flock')).mode & 0o777, 0o600);
  }));

test('writable State or a substituted private lock directory fails before store mutation', () =>
  temporary(async directory => {
    chmodSync(directory, 0o777);
    await assert.rejects(child(directory, `await apps.removeInstalledApp('fixture');`), /directory is corrupt or insecure/);
    chmodSync(directory, 0o755);
    symlinkSync(directory, path.join(directory, '.installed-apps-lock'));
    await assert.rejects(child(directory, `await apps.removeInstalledApp('fixture');`), /executor lock is corrupt or insecure/);
  }));

test('delayed preview preserves newer installed version, unrelated apps and security policy', () =>
  temporary(async directory => {
    await child(directory, `
      const fs = require('node:fs');
      await apps.upsertInstalledApp({ appId: 'fixture', type: 'market', installedVersion: '1.0.0', subdomain: 'fixture' });
      const baseline = await apps.getInstalledApp('fixture');
      fs.writeFileSync(${JSON.stringify(path.join(directory, 'baseline.json'))}, JSON.stringify(baseline));
    `);
    await child(directory, `
      await apps.recordCatalogAppUpdate('fixture', '2.0.0');
      await apps.updateForwardAuthEnabled('fixture', true);
      await apps.updateHealthStatus('fixture', 'unknown', { appHealthState: 'maintenance', healthDetail: 'recovery pending' });
      await apps.upsertInstalledApp({ appId: 'other', type: 'market', installedVersion: '3.0.0', subdomain: 'other' });
    `);
    await child(directory, `
      const baseline = JSON.parse(require('node:fs').readFileSync(${JSON.stringify(path.join(directory, 'baseline.json'))}));
      await apps.mergeInstalledAppPreviews([{ baseline, preview: {
        ...baseline, catalogVersion: '1.1.0', updateAvailable: true, forwardAuthEnabled: false, healthStatus: 'healthy',
      } }]);
    `);
    const store = readStore(directory);
    assert.equal(store.apps.fixture.installedVersion, '2.0.0');
    assert.equal(store.apps.fixture.catalogVersion, '2.0.0');
    assert.equal(store.apps.fixture.updateAvailable, false);
    assert.equal(store.apps.fixture.forwardAuthEnabled, true);
    assert.equal(store.apps.fixture.appHealthState, 'maintenance');
    assert.equal(store.apps.other.installedVersion, '3.0.0');
  }));

test('valid preview merges availability alone; rollback state cannot rewind current security', () =>
  temporary(async directory => {
    await child(directory, `
      const assert = require('node:assert/strict');
      await apps.upsertInstalledApp({ appId: 'fixture', type: 'market', installedVersion: '1.0.0', subdomain: 'fixture' });
      const baseline = await apps.getInstalledApp('fixture');
      await apps.updateForwardAuthEnabled('fixture', true);
      await apps.updateInstalledAppSubdomain('fixture', 'new-location');
      await apps.updateHealthStatus('fixture', 'unhealthy', { healthDetail: 'latest probe' });
      const updates = await apps.mergeInstalledAppPreviews([{ baseline, preview: {
        ...baseline, catalogVersion: '2.0.0', updateAvailable: true, forwardAuthEnabled: false, subdomain: 'old',
      } }]);
      assert.equal(updates.length, 1);
      assert.equal(updates[0].installedVersion, '1.0.0');
      assert.equal(updates[0].forwardAuthEnabled, true);
      assert.equal(updates[0].subdomain, 'new-location');
      assert.equal(updates[0].healthDetail, 'latest probe');
      await apps.restoreInstalledAppUpdateState('fixture', {
        installedVersion: '0.9.0', catalogVersion: null, updateAvailable: false, forwardAuthEnabled: false, subdomain: 'old',
      });
      const restored = await apps.getInstalledApp('fixture');
      assert.equal(restored.installedVersion, '0.9.0');
      assert.equal(restored.forwardAuthEnabled, true);
      assert.equal(restored.subdomain, 'new-location');
    `);
  }));

test('preview never resurrects a removed app or overrides unfinished update admission', () =>
  temporary(async directory => {
    await child(directory, `
      const assert = require('node:assert/strict');
      await apps.upsertInstalledApp({ appId: 'fixture', type: 'market', installedVersion: '1.0.0', subdomain: 'fixture' });
      const baseline = await apps.getInstalledApp('fixture');
      const preview = { ...baseline, catalogVersion: '2.0.0', updateAvailable: true };
      await apps.removeInstalledApp('fixture');
      await apps.mergeInstalledAppPreviews([{ baseline, preview }]);
      assert.equal(await apps.getInstalledApp('fixture'), null);
      await apps.upsertInstalledApp({ appId: 'fixture', type: 'market', installedVersion: '1.0.0', subdomain: 'fixture' });
      await apps.mergeInstalledAppPreviews([{ baseline, preview }]);
      assert.equal((await apps.getInstalledApp('fixture')).updateAvailable, false);
      const current = await apps.getInstalledApp('fixture');
      const { appUpdateJournalStore } = require(${JSON.stringify(path.resolve('src/lib/market/update-admission.ts'))});
      const hash = 'a'.repeat(64);
      const lease = appUpdateJournalStore().create({
        appId: 'fixture', source: { manifestSHA256: hash, artifactSHA256: [] },
        target: { manifestSHA256: hash, artifactSHA256: [] }, metadataBeforeSHA256: hash, originalRunning: {},
        resources: [{ kind: 'app', scope: 'market', name: 'fixture', ownerAppId: 'fixture', mutable: false }],
      });
      lease.recoveryRequired('migration-failed');
      lease.release();
      await apps.mergeInstalledAppPreviews([{ baseline: current, preview: { ...current, updateAvailable: true } }]);
      assert.equal((await apps.getInstalledApp('fixture')).updateAvailable, false);
    `);
  }));

test('corrupt or insecure installed store is never reset by a writer', () =>
  temporary(async directory => {
    const file = path.join(directory, 'installed-apps.json');
    writeFileSync(file, '{broken', { mode: 0o600 });
    await assert.rejects(child(directory, `await apps.updateInstalledVersion('fixture', '2.0.0');`));
    assert.equal(readFileSync(file, 'utf8'), '{broken');
    writeFileSync(file, JSON.stringify({ apps: {}, nextId: 1 }));
    chmodSync(file, 0o644);
    await assert.rejects(child(directory, `await apps.removeInstalledApp('fixture');`), /corrupt or insecure/);
    assert.equal(readFileSync(file, 'utf8'), JSON.stringify({ apps: {}, nextId: 1 }));
  }));
