import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.env.CONTROL_PANEL_ROOT || path.resolve(import.meta.dirname, '..');
const monitor = fs.readFileSync(path.join(root, 'src/lib/health/monitor.ts'), 'utf8');
const bridge = fs.readFileSync(path.join(root, 'src/lib/health/notification-bridge.ts'), 'utf8');

test('health notifications navigate to the role-gated Settings Health page', () => {
  assert.match(monitor, /\/settings\/system\/health/);
  assert.doesNotMatch(monitor, /['"]\/health['"]/);
});

test('notification admin lookup fails loudly instead of returning a false empty result', () => {
  const helper = bridge.slice(bridge.indexOf('async function fetchAdminUserIds'), bridge.indexOf('/**\n * Clear cached UI IP'));
  assert.match(helper, /throw new Error\(`YE-UI admin lookup failed/);
  assert.doesNotMatch(helper, /catch \{/);
});
