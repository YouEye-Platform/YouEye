import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const root = process.env.UI_ROOT || join(import.meta.dirname, '..');
const read = (path) => readFileSync(join(root, path), 'utf8');

test('Market and Settings are regular drawer choices and always present in the all-app launcher', () => {
  const queries = read('src/lib/db/queries/apps.ts');
  const api = read('src/app/api/v1/apps/drawer/route.ts');
  assert.match(queries, /platform-market/);
  assert.match(queries, /platform-settings/);
  assert.match(queries, /visible: config\?\.visible \?\? false/);
  assert.match(api, /launcher_visible/);
  const drawer = read('src/components/layout/app-drawer.tsx');
  const launcher = read('src/components/layout/launcher.tsx');
  assert.match(drawer, /aria-label=\{mode === "add" \? `Add \$\{app\.name\}`/);
  assert.match(drawer, /event\.key !== "Enter" && event\.key !== " "/);
  assert.match(launcher, /const allWithUrl/);
  assert.match(launcher, /for \(const a of allWithUrl\)/);
  assert.doesNotMatch(launcher, /filter\(\(a\) => a\.launcher_visible\)/);
  assert.doesNotMatch(launcher, /Remove \$\{app\.name\} from launcher|Add to launcher|setLauncherPlacement/);
});

test('launcher uses direct desktop drag, mobile rearrange mode, and atomic layout persistence', () => {
  const launcher = read('src/components/layout/launcher.tsx');
  const drag = read('src/lib/hooks/use-grid-drag.ts');
  const route = read('src/app/api/v1/apps/launcher/layout/route.ts');
  const queries = read('src/lib/db/queries/apps.ts');
  assert.match(launcher, /createFolder/);
  assert.match(launcher, /\(hover: hover\) and \(pointer: fine\)/);
  assert.match(launcher, /finePointer \|\| editMode/);
  assert.match(launcher, /touch-pan-y/);
  assert.match(launcher, /\/api\/v1\/apps\/launcher\/layout/);
  assert.match(drag, /classifyGridPointer/);
  assert.match(drag, /reorderDelayMs/);
  assert.match(route, /currentIds\.size !== appIds\.size/);
  assert.match(queries, /db\.transaction/);
});
