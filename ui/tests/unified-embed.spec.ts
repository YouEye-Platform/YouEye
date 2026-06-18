import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const uiRoot = process.env.UI_ROOT || join(import.meta.dirname, '..');
function read(path: string): string {
  return readFileSync(join(uiRoot, path), 'utf8');
}

test('E0: UnifiedEmbed implements the unified youeye: protocol', () => {
  const src = read('src/components/embeds/unified-embed.tsx');
  assert.match(src, /["']youeye:ready["']/);
  assert.match(src, /["']youeye:resize["']/);
  assert.match(src, /["']youeye:action["']/);
});

test('E0: UnifiedEmbed is origin-validated, lazy, with a visible timeout fallback', () => {
  const src = read('src/components/embeds/unified-embed.tsx');
  assert.match(src, /event\.origin !== expectedOrigin/); // origin validation
  assert.match(src, /IntersectionObserver/); // lazy mount
  assert.match(src, /setTimeout/); // timeout
  assert.match(src, /onError\?\.\("timeout"\)/); // never silent on timeout
  assert.match(src, /sandbox="allow-scripts allow-same-origin allow-forms"/);
});

test('E0: UnifiedEmbed delivers theme tokens + accepts legacy messages for one cycle', () => {
  const src = read('src/components/embeds/unified-embed.tsx');
  assert.match(src, /searchParams\.set\("theme"/);
  assert.match(src, /searchParams\.set\("mode"/);
  assert.match(src, /youeye-embed-resize|youeye-card-ready|youeye-app-settings-resize/);
  assert.match(src, /legacy .*message/i); // deprecation warning
});
