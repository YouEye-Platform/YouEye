import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const repoRoot = process.env.CONTROL_PANEL_ROOT || join(import.meta.dirname, '..');

function read(path) {
  return readFileSync(join(repoRoot, path), 'utf8');
}

test('market update checks expose migration preview metadata', () => {
  const installedApps = read('src/lib/market/installed-apps.ts');
  const marketClient = read('src/app/embed/market/client.tsx');

  assert.match(installedApps, /fetchUpdatePlanMigrationsFromSource/);
  assert.match(installedApps, /findApplicableMigrations/);
  assert.match(installedApps, /describeUpdatePath/);
  assert.match(installedApps, /updatePath\?: string \| null/);
  assert.match(installedApps, /migrationsRequired\?: number/);
  assert.match(installedApps, /migrationGates\?: Array/);
  assert.match(installedApps, /app\.updatePath = describeUpdatePath/);
  assert.match(installedApps, /app\.migrationsRequired = applicableMigrations\.length/);
  assert.match(installedApps, /app\.migrationGates = applicableMigrations\.map/);

  assert.match(marketClient, /updatePath\?: string \| null/);
  assert.match(marketClient, /migrationsRequired\?: number/);
  assert.match(marketClient, /Path: \{app\.updatePath\}/);
  assert.match(marketClient, /required migration/);
});
