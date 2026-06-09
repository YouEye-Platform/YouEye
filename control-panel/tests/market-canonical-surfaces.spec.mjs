import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const repoRoot = process.env.CONTROL_PANEL_ROOT || join(import.meta.dirname, '..');

function read(path) {
  return readFileSync(join(repoRoot, path), 'utf8');
}

test('catalog derives notification capability from canonical notification surfaces', () => {
  const catalog = read('src/lib/market/catalog.ts');

  assert.match(catalog, /const hasNotificationSurface = manifest\.surfaces\.some/);
  assert.match(catalog, /surface\.kind === 'notification'/);
  assert.match(catalog, /surface\.placement === 'notification-center'/);
  assert.match(catalog, /notifications: manifest\.capabilities\?\.notifications \|\| \(hasNotificationSurface \? true : undefined\)/);
});
