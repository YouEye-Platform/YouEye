import test from "node:test";
import assert from "node:assert/strict";
import { hasSettingsPanel } from "../src/lib/surfaces/normalize";

const surface = { id: "app-settings", kind: "settings-panel", placement: "app-settings", embedPath: "/embed/settings" };

test("an app's own settings page counts from the capability or from a settings-panel surface", () => {
  // The Control Panel's frozen manifest (an install from the Market).
  assert.equal(hasSettingsPanel({ integration: "native", capabilities: { widgets: true, settings_panel: true } }), true);
  // The app's own /api/manifest (a registration without a frozen manifest, e.g. the reconciler's repair).
  assert.equal(hasSettingsPanel({ name: "Notes", surfaceSchemaVersion: 1, surfaces: [surface] }), true);
});

test("no page, no panel: a bare registration, a schema or an incomplete surface", () => {
  assert.equal(hasSettingsPanel(null), false);
  assert.equal(hasSettingsPanel({ integration: "native" }), false);
  assert.equal(hasSettingsPanel({ settings: { type: "object", properties: {} } }), false);
  assert.equal(hasSettingsPanel({ surfaces: [{ ...surface, embedPath: undefined }] }), false);
  assert.equal(hasSettingsPanel({ capabilities: { settings_panel: false }, surfaces: [{ ...surface, kind: "widget", placement: "dashboard" }] }), false);
});
