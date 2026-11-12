import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import test, { type TestContext } from "node:test";
import ts from "typescript";
import { AppUpdateExecutorLock } from "../src/lib/market/update-executor-lock";
import * as journal from "../src/lib/market/update-journal";
import { SpineAPIError, type CoreUpdateStatus } from "../src/lib/spine/client";
import { coreSchemaComponent } from "../src/lib/updates/core-schema";

const require = createRequire(import.meta.url);
const root = process.env.CONTROL_PANEL_ROOT || process.cwd();
const manifest = "a".repeat(64);
const accepted: CoreUpdateStatus = {
  schema: "youeye.core-status.v1", managed: true,
  installed: {
    manifest_sha256: manifest, accepted_at: "2026-10-29T13:40:00Z",
    machine_bound: true, payload_observation: "not-observed",
    release: { version: "0.5.64", tag: "youeye-v0.5.64", source: "https://example.test/releases", branch: "main", sequence: 1 },
  },
};
function load(file: string, dependencies: Record<string, unknown>, globals: Record<string, unknown> = {}) {
  const api: any = {};
  const code = ts.transpileModule(readFileSync(path.join(root, file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  runInNewContext(code, { ...globals, exports: api, require(id: string) {
    if (Object.hasOwn(dependencies, id)) return dependencies[id];
    if (id.startsWith("node:")) return require(id);
    throw Error(`Unexpected dependency/effect: ${id}`);
  } });
  return api;
}

function fixture(t: TestContext, options: {
  admin?: boolean; signedIn?: boolean; complete?: boolean; unavailable?: boolean;
  status?: CoreUpdateStatus; missingComponent?: boolean; readinessUnavailable?: boolean;
  busy?: boolean; beforePersist?: () => Promise<void>;
}) {
  const directory = mkdtempSync(path.join(tmpdir(), "setup-language-"));
  new journal.AppUpdateJournalStore(directory);
  const componentPath = path.join(directory, "core-component.json");
  if (!options.missingComponent) writeFileSync(componentPath, JSON.stringify({
    schema: "youeye.core-component.v1", role: "cp", requestId: "system:test",
    manifestSHA256: manifest, artifactSHA256: "b".repeat(64),
  }), { mode: 0o600 });
  const busyLock = options.busy
    ? AppUpdateExecutorLock.acquire(path.join(directory, "core-lifecycle.flock"))
    : undefined;
  t.after(() => {
    busyLock?.release();
    rmSync(directory, { recursive: true, force: true });
  });
  let cookieWrites = 0;
  let configReads = 0;
  let settingsWrites = 0, statusReads = 0, componentReads = 0;
  const admission = load("src/lib/market/update-admission.ts", {
    "./update-executor-lock": { AppUpdateExecutorLock }, "./update-journal": journal,
  }, { process: { env: { YOUEYE_APP_UPDATE_JOURNAL_DIR: directory }, geteuid: process.geteuid } });
  const component = { coreSchemaComponent: async (role: "cp" | "ui") => {
    componentReads++;
    assert.equal(role, "cp");
    return coreSchemaComponent(role, componentPath);
  } };
  const spine = { spineClient: {
    getConfig: async () => {
      configReads++;
      if (options.unavailable) throw Error("unavailable");
      return { setup_completed: options.complete };
    },
    getCoreUpdateStatus: async () => {
      statusReads++;
      if (options.readinessUnavailable) throw new SpineAPIError("unavailable", 503);
      return options.status ?? accepted;
    },
  }, SpineAPIError };
  const guard = load("src/lib/updates/core-guard.ts", {
    "../spine/client": spine, "./core-schema": component,
  });
  const readiness = load("src/lib/setup/readiness.ts", {
    "../market/update-admission": admission,
    "../updates/core-guard": guard, "../updates/core-schema": component,
  });
  const api = load("src/app/api/setup/language/route.ts", {
    "next/server": { NextResponse: { json: (body: unknown, init: { status?: number } = {}) => ({ body, status: init.status ?? 200 }) } },
    "next/headers": { cookies: async () => ({ set: () => cookieWrites++ }) },
    "@/lib/auth/session": { getSession: async () => options.signedIn === false ? null : { isAdmin: options.admin } },
    "@/lib/spine/client": spine,
    "@/i18n/config": { locales: ["en", "ru", "es", "de", "fr"] },
    "@/lib/setup/readiness": readiness,
    "@/lib/settings": { settingsService: { setRaw: async (patch: { language: string }) => {
      assert.deepEqual(Object.keys(patch), ["language"]);
      assert.equal(patch.language, "fr");
      // A System writer must remain excluded during the settings effect.
      assert.throws(() => AppUpdateExecutorLock.acquire(path.join(directory, "core-lifecycle.flock")), /lock is busy/);
      settingsWrites++;
      await options.beforePersist?.();
    } } },
  });
  return {
    directory, post: () => api.POST({ json: async () => ({ language: "fr" }) }),
    effects: () => ({ cookieWrites, configReads }),
    securityEffects: () => ({ settingsWrites, statusReads, componentReads }),
  };
}

test("anonymous and standard accounts cannot change language through setup", async t => {
  for (const options of [{ signedIn: false }, { admin: false }]) {
    const f = fixture(t, options);
    assert.equal((await f.post()).status, 403);
    assert.deepEqual(f.effects(), { cookieWrites: 0, configReads: 0 });
    assert.deepEqual(f.securityEffects(), { settingsWrites: 0, statusReads: 0, componentReads: 0 });
  }
});
test("completed setup cannot bypass the normal instance language endpoint", async t => {
  const f = fixture(t, { admin: true, complete: true });
  assert.equal((await f.post()).status, 403);
  assert.deepEqual(f.effects(), { cookieWrites: 0, configReads: 1 });
  assert.deepEqual(f.securityEffects(), { settingsWrites: 0, statusReads: 0, componentReads: 0 });
});
test("unknown setup state fails closed before cookies or configuration change", async t => {
  const f = fixture(t, { admin: true, unavailable: true });
  assert.equal((await f.post()).status, 503);
  assert.deepEqual(f.effects(), { cookieWrites: 0, configReads: 1 });
  assert.deepEqual(f.securityEffects(), { settingsWrites: 0, statusReads: 0, componentReads: 0 });
});

test("an administrator persists setup language only after matching installed acceptance", async t => {
  const f = fixture(t, { admin: true });
  const response = await f.post();
  assert.equal(response.status, 200);
  assert.equal(response.body.language, "fr");
  assert.deepEqual(f.effects(), { cookieWrites: 1, configReads: 1 });
  assert.deepEqual(f.securityEffects(), { settingsWrites: 1, statusReads: 1, componentReads: 1 });
});

test("missing, mismatched, or unfinished installed acceptance prevents configuration writes", async t => {
  for (const status of [
    { ...accepted, managed: false },
    { ...accepted, installed: undefined },
    { ...accepted, installed: { ...accepted.installed!, manifest_sha256: "c".repeat(64) } },
    { ...accepted, installed: { ...accepted.installed!, machine_bound: false } },
    { ...accepted, transaction: {
      request_id: "system:test", manifest_sha256: manifest, phase: "applying",
      restart_required: true, activation_requested: true, target_version: "0.5.64", complete: false, steps: [],
    } },
  ]) {
    const f = fixture(t, { admin: true, status });
    assert.equal((await f.post()).status, 200);
    assert.deepEqual(f.effects(), { cookieWrites: 1, configReads: 1 });
    assert.deepEqual(f.securityEffects(), { settingsWrites: 0, statusReads: 1, componentReads: 1 });
  }
  for (const options of [{ missingComponent: true }, { readinessUnavailable: true }]) {
    const f = fixture(t, { admin: true, ...options });
    assert.equal((await f.post()).status, 200);
    assert.deepEqual(f.effects(), { cookieWrites: 1, configReads: 1 });
    assert.deepEqual(f.securityEffects(), { settingsWrites: 0, statusReads: 1, componentReads: 1 });
  }
});

test("busy or reserved System admission prevents readiness and settings effects", async t => {
  for (const busy of [true, false]) {
    const f = fixture(t, { admin: true, busy });
    if (!busy) writeFileSync(path.join(f.directory, "core-reservation.json"), JSON.stringify({
      schema: "youeye.core-lifecycle.v1", request_id: "system:test", manifest_sha256: manifest,
    }), { mode: 0o600 });
    assert.equal((await f.post()).status, 200);
    assert.deepEqual(f.effects(), { cookieWrites: 1, configReads: 1 });
    assert.deepEqual(f.securityEffects(), { settingsWrites: 0, statusReads: 0, componentReads: 0 });
  }
});

test("setup language retains System admission until asynchronous settings persistence settles", { timeout: 10_000 }, async t => {
  let entered!: () => void, finish!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const f = fixture(t, { admin: true, beforePersist: async () => { entered(); await pending; } });
  const response = f.post();
  try {
    await started;
    assert.throws(() => AppUpdateExecutorLock.acquire(path.join(f.directory, "core-lifecycle.flock")), /lock is busy/);
    assert.deepEqual(f.securityEffects(), { settingsWrites: 1, statusReads: 1, componentReads: 1 });
  } finally { finish(); }
  assert.equal((await response).status, 200);
  const lock = AppUpdateExecutorLock.acquire(path.join(f.directory, "core-lifecycle.flock"));
  lock.release();
  assert.deepEqual(f.effects(), { cookieWrites: 1, configReads: 1 });
});
