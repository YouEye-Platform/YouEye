import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const repoRoot = process.env.CONTROL_PANEL_ROOT || join(import.meta.dirname, '..');

test('update checks reconcile installed app records from install metadata', () => {
  const source = readFileSync(join(repoRoot, 'src/lib/market/installed-apps.ts'), 'utf8');

  assert.match(source, /const installMeta = await readInstallMetadata\(app\.appId\)/);
  assert.match(source, /app\.installedVersion = installMeta\.installedVersion/);
  assert.match(source, /app\.updateAvailable = false/);
  assert.match(source, /installMeta\?\.sourceId/);

  const reconcileIndex = source.indexOf('const installMeta = await readInstallMetadata(app.appId)');
  const compareIndex = source.indexOf('hasUpdate = isNewer(catalogVersion, app.installedVersion)');
  assert.ok(reconcileIndex > -1 && compareIndex > -1 && reconcileIndex < compareIndex);
});
