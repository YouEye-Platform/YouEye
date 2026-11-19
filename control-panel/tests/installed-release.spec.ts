/**
 * Plan 12 Part C: a box shows and reports its installed release's version (the accepted document's `version`), never a
 * build name baked into a file; the details line adds the short git tree.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  publishUIRelease, releaseDetails, releasePartVersion, shortTree, stopUIReleasePublisher, syncUIRelease, uiReleaseRetryDelay,
  UI_RELEASE_PATH, UI_RELEASE_POLL_MS, type UIReleaseIO,
} from '../src/lib/releases/installed-release';

const root = process.env.CONTROL_PANEL_ROOT || path.join(import.meta.dirname, '..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');

test('the details line is the release version and the short git tree', () => {
  const tree = 'b39fe307' + 'a'.repeat(32);
  assert.equal(shortTree(tree), 'b39fe307');
  assert.equal(releaseDetails({ version: '0.6.13', sourceTree: tree }), '0.6.13 · b39fe307');
  assert.equal(releaseDetails({ version: '0.6.13-dev.5' }), '0.6.13-dev.5');
});

test('what the box reports outside uses the installed release, never version.json or Spine\'s baked version', () => {
  // The Names broker heartbeat, the app platform context (requires.youeye, Market messages, app environment).
  assert.match(read('src/lib/youeye-names/maintenance.ts'), /youeyeVersion: \(await installedRelease\(\)\)\?\.version/);
  const platform = read('src/lib/market/platform-env.ts');
  assert.match(platform, /await installedRelease\(\)/);
  assert.doesNotMatch(platform, /spineClient\.version\(\)/);
  // Spine's health row and Pointer's version on the health and AI pages.
  const health = read('src/lib/health/service.ts');
  assert.match(health, /version\.release \|\| selectedRelease\(\)\?\.version/);
  assert.match(health, /await installedPointerVersion\(\)/);
  assert.match(read('src/app/api/ai-system/route.ts'), /await installedPointerVersion\(\)/);
  // The System card shows the release version only (no build span).
  assert.doesNotMatch(read('src/components/settings-shell/core-system-update.tsx'), /release\.build/);
  // The UI is told the release (it cannot read State) and reports it.
  // The 60 s publisher (instrumentation.ts) restores the file; the 3-hour update check no longer does.
  assert.match(read('src/instrumentation.ts'), /startUIReleasePublisher\(\)/);
  assert.doesNotMatch(read('src/lib/apps/update-cache.ts'), /publishUIRelease/);
  assert.match(read('src/lib/infrastructure/deployer.ts'), /publishUIRelease\(\)/);
  const ui = read('../ui/src/lib/build-version.ts');
  assert.match(ui, /\/etc\/youeye\/release\.json/);
  assert.match(read('src/lib/releases/installed-release.ts'), /UI_RELEASE_PATH = '\/etc\/youeye\/release\.json'/);
  for (const route of ['../ui/src/app/api/apps/v1/platform/route.ts', '../ui/src/app/api/v1/telemetry/export/route.ts']) {
    assert.match(read(route), /youeyeVersion\(\)/, route);
  }
});

test('Spine, the Control Panel and the UI show the installed release, never what they report themselves', () => {
  const release = { version: '0.6.12', sourceTree: 'b39fe307' + 'a'.repeat(32) };
  for (const id of ['spine', 'control-panel', 'ui']) assert.equal(releasePartVersion(id, release), '0.6.12', id);
  assert.equal(releasePartVersion('incus', release), undefined);
  assert.equal(releasePartVersion('pointer', release), undefined);
  assert.equal(releasePartVersion('spine', null), undefined);
  for (const route of ['src/app/api/apps/unified/route.ts', 'src/app/api/ui-bridge/apps/route.ts']) {
    const source = read(route);
    assert.match(source, /releasePartVersion\(def\.id, release\)/, route);
    assert.doesNotMatch(source, /status\.(spine|control_panel|ui)\?\.version/, route);
  }
  assert.doesNotMatch(read('src/lib/ui/manager.ts'), /version: ui\.version/);
});

/** A UI container and an accepted release document, in memory. */
function fakeUI(version: string, manifestSHA256 = 'a'.repeat(64)) {
  const files = new Map<string, Buffer>();
  const calls: string[] = [];
  const state = { release: { version, sourceTree: 'c'.repeat(40), manifestSHA256 } as ({ version: string; sourceTree: string; manifestSHA256: string } | null), failUploads: 0, failDownloads: false };
  const io: UIReleaseIO = {
    selected: () => state.release,
    async download(container, path) {
      calls.push(`download ${container} ${path}`);
      if (state.failDownloads) throw new Error('Incus is not answering');
      const body = files.get(`${container}:${path}`);
      if (!body) throw new Error('404 not found');
      return body;
    },
    async upload(container, path, body, options) {
      calls.push(`upload ${container} ${path} ${options.mode}`);
      if (state.failUploads > 0) { state.failUploads--; throw new Error('Incus is not answering'); }
      files.set(`${container}:${path}`, Buffer.from(body));
    },
  };
  const published = () => {
    const body = files.get(`youeye-ui:${UI_RELEASE_PATH}`);
    return body ? JSON.parse(body.toString('utf8')) : null;
  };
  return { io, calls, state, published, files };
}

test('publishUIRelease writes the installed release into the UI only when it differs', async (t) => {
  stopUIReleasePublisher();
  t.after(stopUIReleasePublisher);
  const ui = fakeUI('0.6.12-dev.4');
  await publishUIRelease(ui.io);
  assert.deepEqual(ui.published(), { version: '0.6.12-dev.4', source_tree: 'c'.repeat(40) });
  assert.deepEqual(ui.calls, [`download youeye-ui ${UI_RELEASE_PATH}`, `upload youeye-ui ${UI_RELEASE_PATH} 0644`], 'absent: written');
  ui.calls.length = 0;
  await publishUIRelease(ui.io);
  assert.deepEqual(ui.calls, [`download youeye-ui ${UI_RELEASE_PATH}`], 'the same: not written again');
  // Promotion renamed the release (same files): written.
  ui.state.release = { version: '0.6.12-beta.1', sourceTree: 'c'.repeat(40), manifestSHA256: 'b'.repeat(64) };
  ui.calls.length = 0;
  await publishUIRelease(ui.io);
  assert.equal(ui.published().version, '0.6.12-beta.1');
  assert.equal(ui.calls.length, 2);
  // An unreadable copy is replaced; a failed write is reported to the caller.
  ui.state.failDownloads = true;
  ui.state.failUploads = 1;
  await assert.rejects(publishUIRelease(ui.io), /Incus is not answering/);
  // No accepted release (development): nothing is touched.
  ui.state.release = null;
  ui.calls.length = 0;
  await publishUIRelease(ui.io);
  assert.deepEqual(ui.calls, []);
});

test('the publisher writes when the accepted release changes, retries with backoff, and restores a lost copy', async (t) => {
  stopUIReleasePublisher();
  t.after(stopUIReleasePublisher);
  t.mock.method(console, 'warn', () => {});
  const ui = fakeUI('0.6.12-alpha.1');
  ui.state.failUploads = 3;
  // The UI cannot be written: 30 s, 60 s, 120 s, then the poll interval once it succeeds.
  assert.equal(await syncUIRelease(ui.io), 30_000);
  assert.equal(await syncUIRelease(ui.io), 60_000);
  assert.equal(await syncUIRelease(ui.io), 120_000);
  assert.equal(ui.published(), null);
  assert.equal(await syncUIRelease(ui.io), UI_RELEASE_POLL_MS);
  assert.equal(ui.published().version, '0.6.12-alpha.1');
  // Unchanged: the UI's copy is read, not written.
  ui.calls.length = 0;
  assert.equal(await syncUIRelease(ui.io), UI_RELEASE_POLL_MS);
  assert.deepEqual(ui.calls, [`download youeye-ui ${UI_RELEASE_PATH}`]);
  // The UI container was replaced after the last write (apply-ui runs after the new Control Panel starts): the
  // same release is written again on the next pass.
  ui.files.delete(`youeye-ui:${UI_RELEASE_PATH}`);
  assert.equal(await syncUIRelease(ui.io), UI_RELEASE_POLL_MS);
  assert.equal(ui.published().version, '0.6.12-alpha.1');
  // A metadata-only promotion (alpha → beta of one build) changes the accepted document: published on the next pass.
  ui.state.release = { version: '0.6.12-beta.1', sourceTree: 'c'.repeat(40), manifestSHA256: 'd'.repeat(64) };
  assert.equal(await syncUIRelease(ui.io), UI_RELEASE_POLL_MS);
  assert.equal(ui.published().version, '0.6.12-beta.1');
  // The backoff stops growing at 30 minutes.
  assert.equal(uiReleaseRetryDelay(1), 30_000);
  assert.equal(uiReleaseRetryDelay(20), 30 * 60_000);
  // Started by instrumentation, never on import.
  assert.match(read('src/instrumentation.ts'), /startUIReleasePublisher\(\)/);
});
