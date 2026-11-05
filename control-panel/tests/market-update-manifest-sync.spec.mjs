import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = process.env.CP_ROOT || join(import.meta.dirname, "..");

function read(path) {
  return readFileSync(join(root, path), "utf8");
}

test("market updater syncs updated manifests into YouEye UI", () => {
  const updater = read("src/lib/market/updater.ts");
  const sync = read("src/lib/market/ui-manifest-sync.ts");

  assert.match(updater, /syncAppManifestObjectToUI/);
  assert.match(updater, /Syncing app manifest to YouEye UI/);
  assert.match(updater, /syncAppManifestObjectToUI\(appId, manifest/);
  assert.match(updater, /totalSteps \+= 3; \/\/ sync UI manifest \+ save metadata \+ cleanup/);

  assert.match(sync, /export async function syncAppManifestObjectToUI/);
  assert.match(sync, /X-UI-Bridge-Token/);
  assert.match(sync, /\/api\/v1\/apps\/.+\/manifest/);
  assert.match(sync, /pushConnectionsToUI/);
  assert.match(sync, /await pushConnectionsToUI\(appId\)/);

  const manager = read("src/lib/bridges/manager.ts");
  assert.match(manager, /accessMode: 'proxy'/);
  assert.match(manager, /host: target\.host/);
  assert.doesNotMatch(manager, /https:\/\/\$\{meta\.subdomain\}/);
});
