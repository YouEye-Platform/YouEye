import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const repoRoot = process.env.CONTROL_PANEL_ROOT || join(import.meta.dirname, '..');

function read(path) {
  return readFileSync(join(repoRoot, path), 'utf8');
}

test('market update checks expose migration preview metadata', () => {
  // The migration-preview metadata (updatePath / migrationsRequired /
  // migrationGates) is computed in installed-apps.ts. The market embed client
  // that rendered it (src/app/embed/market/client.tsx) was removed when the
  // market UI was restructured; the metadata contract itself is what update
  // consumers rely on, so assert on the source of truth.
  const installedApps = read('src/lib/market/installed-apps.ts');

  assert.match(installedApps, /fetchUpdatePlanMigrationsFromSource/);
  assert.match(installedApps, /findApplicableMigrations/);
  assert.match(installedApps, /describeUpdatePath/);
  assert.match(installedApps, /updatePath\?: string \| null/);
  assert.match(installedApps, /migrationsRequired\?: number/);
  assert.match(installedApps, /migrationGates\?: Array/);
  assert.match(installedApps, /app\.updatePath = describeUpdatePath/);
  assert.match(installedApps, /app\.migrationsRequired = applicableMigrations\.length/);
  assert.match(installedApps, /app\.migrationGates = applicableMigrations\.map/);
});
