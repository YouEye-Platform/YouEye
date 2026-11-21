import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { readFileSync } from "node:fs";
import { CoreSystemUpdate } from "../src/components/settings-shell/core-system-update";
import type { CoreUpdateStatus } from "../src/lib/spine/client";

type Step = NonNullable<CoreUpdateStatus["transaction"]>["steps"][number];
const hash = "a".repeat(64);

function panel(steps: Step[], transaction: Partial<NonNullable<CoreUpdateStatus["transaction"]>> = {}, locale = "en") {
  const status: CoreUpdateStatus = {
    schema: "youeye.core-status.v1", managed: true,
    installed: { manifest_sha256: hash, release: { version: "0.6.9", tag: "youeye-v0.6.9", sequence: 1, source_tree: "b".repeat(40) }, accepted_at: "2026-11-18T10:00:00Z", machine_bound: true, payload_observation: "not-observed" },
    transaction: { request_id: "update-1", manifest_sha256: "c".repeat(64), phase: "needs-recovery", restart_required: false, activation_requested: false, target_version: "0.6.10", complete: false, steps, ...transaction },
  };
  const messages = JSON.parse(readFileSync(new URL(`../messages/${locale}.json`, import.meta.url), "utf8"));
  const html = renderToStaticMarkup(createElement(NextIntlClientProvider, {
    locale, messages, timeZone: "UTC", now: new Date("2026-01-01T00:00:00Z"),
    children: createElement(CoreSystemUpdate, { initial: status }),
  }));
  assert.doesNotMatch(html, /MISSING_MESSAGE|interface\.m[0-9a-f]{12}/);
  return html;
}
const graph = (states: Record<string, Partial<Step>>): Step[] =>
  ["verify-members", "checkpoint", "apply-cp", "apply-ui", "authenticated-health"].map(name => ({ name, state: "pending", ...states[name] }));

test("a failed preparation step offers Cancel and its reason, never Resume", () => {
  const html = panel(graph({ "verify-members": { state: "failed", evidence: "installed members could not be read <b>" } }));
  assert.match(html, /Cancel preparation/);
  assert.match(html, /This step failed: Verifying the complete release/);
  assert.match(html, /Reason: installed members could not be read &lt;b&gt;/);
  assert.match(html, /The installed release is unchanged\. Cancel this update, then check for updates again\./);
  assert.doesNotMatch(html, /Resume checks|Retry update|Restore previous release/);
});

test("a failed preparation step can be cancelled even when activation was requested", () => {
  const steps = graph({ "verify-members": { state: "failed" } });
  assert.match(panel(steps, { activation_requested: true }), /Cancel preparation/);
  // Without a failure, a requested activation still hides Cancel: the next step may start at any moment.
  const running = panel(graph({ "verify-members": { state: "started" } }), { phase: "applying", activation_requested: true });
  assert.doesNotMatch(running, /Cancel preparation/);
});

test("a failed later step offers the previous release and its reason, never Resume or Cancel", () => {
  const html = panel(graph({ "verify-members": { state: "succeeded" }, checkpoint: { state: "failed", evidence: "checkpoint preflight refused before any writer was stopped: not enough space" } }));
  assert.match(html, /Restore previous release/);
  assert.match(html, /This step failed: Saving the recovery point/);
  assert.match(html, /Reason: checkpoint preflight refused before any writer was stopped: not enough space/);
  assert.doesNotMatch(html, /Resume checks|Cancel preparation|The installed release is unchanged/);
});

test("a failed step without a reason still shows which step failed", () => {
  const html = panel(graph({ "verify-members": { state: "failed" } }));
  assert.match(html, /This step failed: Verifying the complete release/);
  assert.doesNotMatch(html, /Reason:/);
});

test("without a failed step the panel keeps Resume", () => {
  const html = panel(graph({ "verify-members": { state: "started" } }), { phase: "applying" });
  assert.match(html, /Resume checks/);
  assert.match(html, /Cancel preparation/);
  assert.doesNotMatch(html, /This step failed|Reason:/);
});

for (const [locale, failed, reason] of [
  ["de", "Dieser Schritt ist fehlgeschlagen: ", "Grund: "],
  ["es", "Este paso ha fallado: ", "Motivo: "],
  ["fr", "Cette étape a échoué : ", "Raison : "],
  ["ru", "Этот шаг не выполнен: ", "Причина: "],
]) {
  test(`the failed-step messages render in ${locale}`, () => {
    const html = panel(graph({ "verify-members": { state: "failed", evidence: "spine text" } }), {}, locale);
    assert.ok(html.includes(failed));
    assert.ok(html.includes(`${reason}spine text`));
    assert.ok(!html.includes("This step failed"));
  });
}

const unchangedNotice = /The last update was (cancelled|rolled back)\. The installed release is unchanged\./;

test("a preflight refused and cancelled by Spine says which step failed and why", () => {
  const html = panel(graph({ "verify-members": { state: "succeeded" }, checkpoint: { state: "failed", evidence: "checkpoint preflight refused before any writer was stopped: insufficient combined Data checkpoint/staging/recovery capacity" } }),
    { phase: "cancelled", complete: true, error: "System update stopped before any service was touched." });
  assert.match(html, /Preparation cancelled/);
  assert.match(html, /The last update was cancelled\. The installed release is unchanged\./);
  assert.match(html, /This step failed: Saving the recovery point/);
  assert.match(html, /Reason: checkpoint preflight refused before any writer was stopped: insufficient combined Data checkpoint\/staging\/recovery capacity/);
  assert.doesNotMatch(html, /Cancel preparation|Restore previous release|Resume checks|Cancel this update/);
});

test("a cancelled request without a failed step shows no notice", () => {
  const html = panel(graph({ "verify-members": { state: "succeeded" } }), { phase: "cancelled", complete: true });
  assert.match(html, /Preparation cancelled/);
  assert.doesNotMatch(html, unchangedNotice);
  assert.doesNotMatch(html, /This step failed|Reason:/);
});

test("a rolled-back request names the apply step that stopped it and why", () => {
  const recovery = ["recovery-fence", "recovery-paired-restore", "recovery-health"].map(name => ({ name, state: "succeeded" }));
  const html = panel(recovery, { phase: "rolled-back", complete: true,
    stopped_step: { name: "apply-cp", state: "started", evidence: "cp payload before start: installed payload differs from its recorded files: 0 unrecorded, 2 changed, 1 missing" } });
  assert.match(html, /Previous release restored/);
  assert.match(html, /The last update was rolled back\. The installed release is unchanged\./);
  assert.match(html, /This step failed: Updating the server interface/);
  assert.match(html, /Reason: cp payload before start: installed payload differs from its recorded files: 0 unrecorded, 2 changed, 1 missing/);
  // Without a known step it still says the update was rolled back.
  const bare = panel(recovery, { phase: "rolled-back", complete: true });
  assert.match(bare, /The last update was rolled back\./);
  assert.doesNotMatch(bare, /This step failed|Reason:/);
});

test("an uncertain step in needs-recovery shows the reason its action recorded", () => {
  const html = panel(graph({ "verify-members": { state: "succeeded" }, checkpoint: { state: "succeeded" }, "apply-cp": { state: "started", evidence: "cp payload before start: installed payload differs from its recorded files: 0 unrecorded, 2 changed, 1 missing" } }),
    { error: "Native action outcome is uncertain; resume its retained checks or use verified recovery" });
  assert.match(html, /Needs attention · Updating the server interface/);
  assert.match(html, /Native action outcome is uncertain/);
  assert.match(html, /Reason: cp payload before start: installed payload differs from its recorded files: 0 unrecorded, 2 changed, 1 missing/);
  assert.match(html, /Restore previous release/);
  assert.doesNotMatch(html, /This step failed|Cancel preparation/);
  // The same step while still applying shows no reason (Spine sends none there either).
  const applying = panel(graph({ "verify-members": { state: "succeeded" }, checkpoint: { state: "succeeded" }, "apply-cp": { state: "started", evidence: "spine text" } }), { phase: "applying" });
  assert.doesNotMatch(applying, /Reason:/);
});

test("cancelling over a failed checkpoint offers Cancel; needs-recovery over one does not", () => {
  const steps = graph({ "verify-members": { state: "succeeded" }, checkpoint: { state: "failed", evidence: "checkpoint preflight refused before any writer was stopped: not enough space" } });
  const html = panel(steps, { phase: "cancelling", activation_requested: true });
  assert.match(html, /Cancelling preparation · Saving the recovery point/);
  assert.match(html, /Cancel preparation/);
  assert.match(html, /This step failed: Saving the recovery point/);
  assert.match(html, /The installed release is unchanged\. Cancel this update, then check for updates again\./);
  assert.doesNotMatch(html, /Resume checks|Restore previous release/);
  assert.doesNotMatch(panel(steps, { phase: "needs-recovery" }), /Cancel preparation/);
  // A later step that started keeps Cancel away even while cancelling.
  assert.doesNotMatch(panel(graph({ "verify-members": { state: "succeeded" }, checkpoint: { state: "failed" }, "apply-cp": { state: "started" } }), { phase: "cancelling" }), /Cancel preparation/);
});

test("a clean committed update shows no failure, reason or notice", () => {
  const html = panel(graph(Object.fromEntries(["verify-members", "checkpoint", "apply-cp", "apply-ui", "authenticated-health"].map(name => [name, { state: "succeeded" }]))),
    { phase: "committed", complete: true });
  assert.match(html, /Update complete/);
  assert.doesNotMatch(html, unchangedNotice);
  assert.doesNotMatch(html, /This step failed|Reason:|Cancel preparation|Restore previous release|Resume checks/);
});

for (const [locale, cancelled, rolledBack] of [
  ["de", "Das letzte Update wurde abgebrochen.", "Das letzte Update wurde rückgängig gemacht."],
  ["es", "La última actualización se ha cancelado.", "La última actualización se ha revertido."],
  ["fr", "La dernière mise à jour a été annulée.", "La dernière mise à jour a été annulée par une restauration."],
  ["ru", "Последнее обновление отменено.", "Последнее обновление откачено."],
]) {
  test(`the last-update notices render in ${locale}`, () => {
    const failed = panel(graph({ checkpoint: { state: "failed", evidence: "spine text" } }), { phase: "cancelled", complete: true }, locale);
    assert.ok(failed.includes(cancelled));
    const restored = panel([{ name: "recovery-health", state: "succeeded" }], { phase: "rolled-back", complete: true }, locale);
    assert.ok(restored.includes(rolledBack));
    assert.ok(!failed.includes("The last update") && !restored.includes("The last update"));
  });
}

test("a first admission that timed out offers Cancel beside Retry update", () => {
  const timedOut: Partial<Step> = { state: "started", action_state: "retryable", stage: "admission", code: "admission_timeout", effect_state: "not-started" };
  const steps = graph({ "verify-members": { state: "succeeded" }, checkpoint: timedOut });
  for (const activation_requested of [false, true]) {
    const html = panel(steps, { phase: "applying", activation_requested });
    assert.match(html, /Cancel preparation/);
    assert.match(html, /Retry update/);
    assert.doesNotMatch(html, /Restore previous release/);
  }
  // A checkpoint that was launched, is still waiting, or whose outcome is unknown offers no Cancel.
  for (const checkpoint of [
    { state: "started" }, { state: "started", action_state: "running", stage: "admission", effect_state: "not-started" },
    { state: "started", action_state: "unknown" }, { ...timedOut, effect_state: "started" },
  ] as Partial<Step>[]) {
    assert.doesNotMatch(panel(graph({ "verify-members": { state: "succeeded" }, checkpoint }), { phase: "applying" }), /Cancel preparation/);
  }
  // Nor does a later step whose admission ended.
  assert.doesNotMatch(panel(graph({ "verify-members": { state: "succeeded" }, checkpoint: { state: "succeeded" }, "apply-cp": timedOut }), { phase: "applying" }), /Cancel preparation/);
  // A cancellation that did not finish over such a checkpoint can be finished.
  assert.match(panel(graph({ "verify-members": { state: "succeeded" }, checkpoint: { state: "started" } }), { phase: "cancelling" }), /Cancel preparation/);
});

test("a System update action waits longer for Spine than Spine waits for a gap in the pruning", async () => {
  const { CORE_UPDATE_ACTION_TIMEOUT_MS } = await import("../src/lib/spine/client");
  const spine = readFileSync(new URL("../../spine/internal/api/core_update_actions.go", import.meta.url), "utf8");
  const wait = spine.match(/coreActionPruneWait = (\d+) \* time\.Second/);
  assert.ok(wait, "Spine's wait for the pruning");
  // Half a minute on top: the action itself (staging reads and checks the release document) comes after the wait.
  assert.ok(CORE_UPDATE_ACTION_TIMEOUT_MS >= (Number(wait[1]) + 30) * 1000, `${CORE_UPDATE_ACTION_TIMEOUT_MS} ms against ${wait[1]} s`);
  const client = readFileSync(new URL("../src/lib/spine/client.ts", import.meta.url), "utf8");
  assert.match(client, /core-update\/\$\{action\}`, 'POST', \{ \.\.\.request \}, CORE_UPDATE_ACTION_TIMEOUT_MS\)/);
});
