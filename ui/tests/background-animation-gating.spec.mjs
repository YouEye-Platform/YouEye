import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const root = process.env.UI_ROOT || join(import.meta.dirname, '..');

function read(path) {
  return readFileSync(join(root, path), 'utf8');
}

test('homepage animated backgrounds only auto-disable for reduced motion', () => {
  const component = read('src/components/backgrounds/homepage-background.tsx');

  assert.match(component, /prefers-reduced-motion: reduce/);
  assert.match(component, /systemPrefersReducedMotion/);
  assert.match(component, /userDisabledAnimations/);
  assert.doesNotMatch(component, /hardwareConcurrency/);
});

test('legacy UI System and Users settings embed routes are retired', () => {
  assert.equal(existsSync(join(root, 'src/app/settings/system/page.tsx')), false);
  assert.equal(existsSync(join(root, 'src/app/settings/users/page.tsx')), false);
});
