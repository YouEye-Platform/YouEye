import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = join(import.meta.dirname, '..');

test('independently orphaned Settings components stay retired', () => {
  const retired = [
    'accounts-settings.tsx',
    'app-drawer-settings.tsx',
    'branding-settings.tsx',
    'icon-picker-branding.tsx',
    'permission-manager.tsx',
    'pin-manager.tsx',
  ];

  for (const file of retired) {
    assert.equal(
      existsSync(join(root, 'src/components/settings', file)),
      false,
      `${file} must stay retired`,
    );
  }
});

test('UI does not ship the Control Panel-owned Settings application', () => {
  for (const path of ['src/app/settings', 'src/components/settings']) {
    const absolute = join(root, path);
    assert.equal(
      !existsSync(absolute) ||
        readdirSync(absolute, { recursive: true, withFileTypes: true }).every(
          (entry) => !entry.isFile(),
        ),
      true,
      `${path} must stay empty or absent`,
    );
  }

  const header = readFileSync(join(root, 'src/app/api/v1/header/config/route.ts'), 'utf8');
  assert.match(header, /app_settings_url: `\$\{uiBaseUrl\}\/settings\/apps\//);
});
