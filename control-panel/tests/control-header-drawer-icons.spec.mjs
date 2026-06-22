import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = join(import.meta.dirname, "..");

function read(path) {
  return readFileSync(join(root, path), "utf8");
}

test("Control header hosts the UI-served drawer and launcher", () => {
  const header = read("src/components/control-surface/control-header.tsx");

  assert.match(header, /<DotsIcon className="h-4 w-4" \/>/);
  assert.match(header, /ui_base_url/);
  assert.match(header, /function PlatformOverlayFrame/);
  assert.match(header, /kind="drawer"/);
  assert.match(header, /kind="launcher"/);
  assert.match(header, /kind="notifications"/);
  assert.match(header, /\/embed\/\$\{kind\}\?\$\{params\.toString\(\)\}/);
  assert.match(header, /prewarmOverlays/);
  assert.match(header, /requestIdleCallback/);
  assert.match(header, /youeye:overlay-visibility/);
  assert.match(header, /active && loaded/);
  assert.match(header, /open-launcher/);
  assert.match(header, /<iframe[\s\S]*title=\{`YouEye \$\{kind\}`\}/);
  assert.doesNotMatch(header, /apps\/drawer/);
  assert.doesNotMatch(header, /editDrawer|GripVertical|Hidden apps|persistDrawerPrefs|displayIcon/);
});
