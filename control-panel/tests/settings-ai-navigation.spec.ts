import assert from "node:assert/strict";
import test from "node:test";
import { AI_SECTIONS, isAISectionActive } from "../src/components/settings-shell/ai-navigation";

test("AI navigation selects defaults, details and retained route aliases", () => {
  for (const [path, expected] of [
    ["/settings/ai", "/models"],
    ["/settings/ai/models/example", "/models"],
    ["/settings/ai/groups/example", "/groups"],
    ["/settings/ai/keys", "/instances"],
    ["/settings/ai/keys/example", "/instances"],
    ["/settings/ai/instances/example", "/instances"],
    ["/settings/ai/connections/example", "/providers"],
    ["/settings/ai/playground", "/test-model"],
    ["/settings/ai/compare", "/test-model"],
    ["/settings/ai/chat", "/test-model"],
    ["/settings/ai/usage", "/dashboard"],
    ["/settings/ai/diagnostics", "/dashboard"],
  ]) assert.equal(isAISectionActive(path, expected), true, path);
});

test("AI navigation exposes one destination for overview and model testing", () => {
  assert.deepEqual(AI_SECTIONS.map(section => section.href), [
    "/models", "/providers", "/instances", "/groups", "/routing", "/dashboard", "/test-model",
  ]);
  assert.deepEqual(AI_SECTIONS.map(section => section.labelKey), [
    "models", "providers", "instances", "groups", "routing", "dashboard", "testModel",
  ]);
});

test("AI navigation does not confuse similarly named or unrelated routes", () => {
  assert.equal(isAISectionActive("/settings/ai/models-other", "/models"), false);
  assert.equal(isAISectionActive("/settings/ai/providers", "/models"), false);
  assert.equal(isAISectionActive("/settings/appearance", "/models"), false);
  assert.equal(isAISectionActive("/settings/ai-other", "/models"), false);
});
