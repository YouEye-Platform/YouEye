import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = join(import.meta.dirname, "..");
const read = (path) => readFileSync(join(root, path), "utf8");

test("Control Panel accepts declarable settings-panel surfaces", () => {
  const schema = read("src/lib/market/schema.ts");
  const appsClient = read("src/components/settings-shell/apps-client.tsx");

  assert.match(schema, /surfaceSchemaVersion/);
  assert.match(schema, /'settings-panel'/);
  assert.match(appsClient, /\/embed\/settings/);
  assert.match(appsClient, /youeye:ready/);
  assert.match(appsClient, /youeye:resize/);
  assert.doesNotMatch(appsClient, /youeye-app-settings-resize|settings\?embed=true/);
});
