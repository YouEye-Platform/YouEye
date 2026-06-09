import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const repoRoot = process.env.CONTROL_PANEL_ROOT || join(import.meta.dirname, '..');

function read(path) {
  return readFileSync(join(repoRoot, path), 'utf8');
}

test('market catalog supports durable update-plan artifacts', () => {
  const schema = read('src/lib/market/schema.ts');
  const parser = read('src/lib/market/parser.ts');
  const catalog = read('src/lib/market/catalog.ts');

  assert.match(schema, /UpdatePlanSchema/);
  assert.match(schema, /kind:\s*z\.literal\('update-plan'\)/);
  assert.match(schema, /updatePlans:\s*z\.array\(UpdatePlanCatalogEntrySchema\)/);
  assert.match(parser, /parseUpdatePlan/);
  assert.match(catalog, /fetchUpdatePlanMigrationsFromSource/);
});

test('updater merges durable update-plan gates and records idempotency', () => {
  const updater = read('src/lib/market/updater.ts');
  const planner = read('src/lib/market/migration-planner.ts');

  assert.match(updater, /fetchUpdatePlanMigrationsFromSource/);
  assert.match(updater, /mergeMigrationSources/);
  assert.match(updater, /manifest\.update\?\.migrations \|\| \[\], durableMigrationPlan\.migrations/);
  assert.match(planner, /appliedKeys\.has\(migration\.idempotencyKey\)/);
  assert.match(updater, /recordAppliedMigration/);
  assert.match(updater, /source:\s*migration\.source/);
});
