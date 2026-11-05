import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = process.env.CONTROL_PANEL_ROOT || join(import.meta.dirname, '..');

test('retired Control Panel component trees and leaf barrels stay absent', () => {
  const retiredTrees = [
    'src/components/containers',
    'src/components/dashboard',
    'src/components/layout',
    'src/components/proxy',
    'src/components/settings',
  ];
  for (const path of retiredTrees) {
    const absolute = join(root, path);
    assert.equal(
      !existsSync(absolute) || readdirSync(absolute, { recursive: true }).length === 0,
      true,
      `${path} must stay empty or absent`,
    );
  }

  const retiredFiles = [
    'src/components/market/app-card.tsx',
    'src/components/market/install-progress.tsx',
    'src/components/market/orphan-section.tsx',
    'src/components/ui/form.tsx',
    'src/components/ui/scroll-area.tsx',
    'src/hooks/use-site-config.ts',
    'src/lib/incus/index.ts',
    'src/lib/market/index.ts',
    'src/types/index.ts',
  ];

  for (const path of retiredFiles) {
    assert.equal(existsSync(join(root, path)), false, `${path} must stay retired`);
  }
});

test('dependencies used only by retired Control Panel leaves stay removed', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  assert.equal(manifest.dependencies?.['@radix-ui/react-scroll-area'], undefined);
  assert.equal(manifest.dependencies?.['react-hook-form'], undefined);
});
