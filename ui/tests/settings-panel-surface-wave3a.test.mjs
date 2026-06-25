import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = join(import.meta.dirname, "..");
const read = (path) => readFileSync(join(root, path), "utf8");

test("UI app-management and settings embeds use declarable settings-panel surfaces", () => {
  const appManagement = read("src/lib/db/queries/app-management.ts");
  const appSettings = read("src/components/settings/app-settings-detail.tsx");

  assert.match(appManagement, /surfaceSchemaVersion/);
  assert.match(appManagement, /settings-panel/);
  assert.match(appSettings, /\/embed\/settings/);
  assert.doesNotMatch(appSettings, /settings\?embed=true|youeye-app-settings-resize/);
});
