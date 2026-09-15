import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.env.CONTROL_PANEL_ROOT || path.resolve(import.meta.dirname, '..');
const ui = fs.readFileSync(path.join(root, 'src/components/settings-shell/apps-client.tsx'), 'utf8');
const route = fs.readFileSync(path.join(root, 'src/app/api/apps/[name]/health-policy/route.ts'), 'utf8');
const prober = fs.readFileSync(path.join(root, 'src/lib/market/app-prober.ts'), 'utf8');

test('app overview exposes the owner auto-restart opt-out', () => {
  assert.match(ui, /Automatic recovery/);
  assert.match(ui, /health-policy/);
  assert.match(ui, /<Switch/);
});

test('health policy is admin and CSRF protected and persisted in install metadata', () => {
  assert.match(route, /session\.isAdmin/);
  assert.match(route, /verifyCSRFToken/);
  assert.match(route, /saveInstallMetadata/);
  assert.match(route, /metadata\.autoRestart = body\.autoRestart/);
});

test('dependency failures explain waiting state without entering the restart path', () => {
  assert.match(prober, /return await handleDependencyWait/);
  const helper = prober.slice(prober.indexOf('async function handleDependencyWait'), prober.indexOf('async function restartWithDependencies'));
  assert.doesNotMatch(helper, /restartWithDependencies|observeIssue/);
});
