import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

// Plan 1 E4 (D14-revised) — the CP account dropdown mirrors the toned-down UI panel.
// Run: CONTROL_PANEL_ROOT="$PWD" pnpm exec node --import tsx --test tests/user-menu-e4.spec.ts
const root = process.env.CONTROL_PANEL_ROOT || process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");
const header = read("src/components/control-surface/control-header.tsx");

test("CP account dropdown is the 340px toned-down panel (not the old w-56 list)", () => {
  // the panel sits inside the existing DropdownMenu trigger
  assert.match(header, /w-\[340px\] rounded-3xl/);
  assert.doesNotMatch(header, /className="w-56"/);
});

test("mirrors the UI structure: avatar, greeting, Timeline, Settings, Sign out", () => {
  assert.match(header, /size-\[76px\]/);            // big avatar
  assert.match(header, /Hi, \{firstName\}!/);
  assert.match(header, />\s*Timeline/);
  assert.match(header, />\s*Settings/);
  assert.match(header, />\s*Sign out/);
});

test("Light/Dark/Auto segmented control replaces the single cycle item", () => {
  assert.match(header, /THEME_MODES/);
  assert.match(header, /applyTheme\(mode\)/);
  assert.match(header, /aria-pressed=\{active\}/);
  assert.doesNotMatch(header, /cycleTheme/);
});

test("no borrowed account-panel details (no Manage-account pill, no Privacy·About footer)", () => {
  assert.doesNotMatch(header, />\s*Manage your account/);
  assert.doesNotMatch(header, />\s*About this server/);
});

test("dropdown primitives slimmed (Item/Label/Separator no longer used)", () => {
  assert.doesNotMatch(header, /DropdownMenuItem/);
  assert.doesNotMatch(header, /DropdownMenuLabel/);
  assert.doesNotMatch(header, /DropdownMenuSeparator/);
});
