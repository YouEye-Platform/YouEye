import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.env.CONTROL_PANEL_ROOT || path.resolve(import.meta.dirname, '..');
const guardedRoutes = [
  'src/app/api/updates/[component]/route.ts',
  'src/app/api/deploy/infrastructure/system-updates/route.ts',
  'src/app/api/market/install/route.ts',
];

test('platform update, system operations, and app install all invoke the critical issue gate', () => {
  for (const relative of guardedRoutes) {
    const source = fs.readFileSync(path.join(root, relative), 'utf8');
    assert.match(source, /assertNoCriticalIssues\(/, `${relative} must invoke the gate`);
  }
});
