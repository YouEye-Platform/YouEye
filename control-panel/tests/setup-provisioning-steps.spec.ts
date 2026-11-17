// Run: node --import tsx --test tests/setup-provisioning-steps.spec.ts
// Parallel provisioning (Plan 8 item 13): independent steps run together, each
// keeps its own record, reason and times, and one failure stops none of the others.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  runSetupStepsTogether,
  setupStepStore,
  StepFailure,
  type SetupStepContext,
} from '../src/lib/setup/provisioning-steps';

function fakeConfig(initial: Record<string, unknown> = {}) {
  let config: Record<string, unknown> = structuredClone(initial);
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  return {
    get value() { return config; },
    access: {
      // Every read and write yields, so unserialised writers would interleave.
      read: async () => { await tick(); return structuredClone(config); },
      patch: async (patch: Record<string, unknown>) => {
        await tick();
        for (const [key, value] of Object.entries(patch)) {
          if (value === null) delete config[key]; else config[key] = structuredClone(value);
        }
        return {};
      },
    },
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

function context(store: ReturnType<typeof setupStepStore>, done: Set<string> = new Set()) {
  const events: Array<[string, string, string | undefined]> = [];
  let heartbeats = 0;
  const value: SetupStepContext = {
    store,
    shouldRun: (id) => !done.has(id),
    heartbeat: async () => { heartbeats++; },
    report: (id, status, message) => { events.push([id, status, message]); },
  };
  return { value, events, heartbeats: () => heartbeats };
}

test('independent steps run at the same time and one failure stops none of the others', async () => {
  const config = fakeConfig({ setup_steps: { config: 'done', caddy: 'done' } });
  let clock = Date.parse('2026-11-17T10:00:00.000Z');
  const store = setupStepStore(config.access, () => new Date(clock += 1_000));
  const ctx = context(store);
  const gate = deferred();
  const started = new Set<string>();
  const step = (id: string, fail = false) => [id, async () => {
    started.add(id);
    await gate.promise;
    if (fail) throw new StepFailure('YouEye AI service setup failed: no route', 'no route');
    return `${id} ok`;
  }] as const;
  const run = runSetupStepsTogether(ctx.value, [step('names'), step('dns'), step('ai', true), step('sso_control'), step('sso_ui')]);
  // Every step is under way before any of them may finish.
  while (started.size < 5) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual([...started].sort(), ['ai', 'dns', 'names', 'sso_control', 'sso_ui']);
  gate.resolve();
  assert.equal(await run, false);

  const saved = config.value;
  assert.deepEqual(saved.setup_steps, { config: 'done', caddy: 'done', names: 'done', dns: 'done', ai: 'error', sso_control: 'done', sso_ui: 'done' });
  assert.deepEqual(saved.setup_step_errors, { ai: 'no route' });
  const times = saved.setup_step_times as Record<string, { startedAt: string; finishedAt: string }>;
  for (const id of ['names', 'dns', 'ai', 'sso_control', 'sso_ui']) {
    assert.ok(Date.parse(times[id].startedAt) < Date.parse(times[id].finishedAt), id);
  }
  assert.deepEqual(ctx.events.filter(([, status]) => status === 'error'), [['ai', 'error', 'YouEye AI service setup failed: no route']]);
  assert.equal(ctx.events.filter(([, status]) => status === 'done').length, 4);
});

test('a retry runs only unfinished steps and clears the earlier reason', async () => {
  const config = fakeConfig({ setup_steps: { names: 'done', dns: 'done', ai: 'error' }, setup_step_errors: { ai: 'no route' } });
  const store = setupStepStore(config.access);
  const ctx = context(store, new Set(['names', 'dns']));
  const ran: string[] = [];
  const ok = await runSetupStepsTogether(ctx.value, ['names', 'dns', 'ai'].map((id) => [id, async () => { ran.push(id); return 'ok'; }] as const));
  assert.equal(ok, true);
  assert.deepEqual(ran, ['ai']);
  assert.deepEqual(config.value.setup_steps, { names: 'done', dns: 'done', ai: 'done' });
  assert.equal(config.value.setup_step_errors, undefined);
  assert.deepEqual(ctx.events.filter(([id]) => id !== 'ai'), [['names', 'done', 'Already completed'], ['dns', 'done', 'Already completed']]);
});

test('the setup lease is renewed while a long step waits', async () => {
  const store = setupStepStore(fakeConfig().access);
  const ctx = context(store);
  const ok = await runSetupStepsTogether(ctx.value, [['names', async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
    return 'ok';
  }]], 10);
  assert.equal(ok, true);
  assert.ok(ctx.heartbeats() >= 3, `heartbeats: ${ctx.heartbeats()}`);
});

test('setup runs Names activation, DNS, AI and both SSO steps together after config and Caddy', () => {
  const route = readFileSync(path.join(process.cwd(), 'src/app/api/setup/run/route.ts'), 'utf8');
  const together = route.indexOf('runSetupStepsTogether(stepContext, [');
  assert.ok(route.indexOf("if (shouldRunStep('config'))") < route.indexOf("if (shouldRunStep('caddy'))"));
  assert.ok(route.indexOf("if (shouldRunStep('caddy'))") < together);
  for (const id of ['names', 'dns', 'ai', 'sso_control', 'sso_ui']) assert.ok(route.indexOf(`['${id}', async () => {`) > together, id);
  assert.ok(route.indexOf("assertProvisioningStepsComplete({") > route.indexOf("['sso_ui', async () => {"));
  // Provisioning awaits the job started after the human check; it never claims or requests.
  assert.match(route, /awaitNamesCertificate\(name, body\.domain\)[\s\S]*activateNamesCertificate\(body\.domain\)/);
  assert.doesNotMatch(route, /claimName|requestCertificate|yen_human_verification_proof|yen_verified_setup_session/);
  // Caddy writers that may overlap go one at a time.
  assert.match(route, /hasError = await withCaddyMutation\(async \(\) => \{/);
  assert.match(route, /withCaddyMutation\(\(\) => caddy\.reconcileManagedRoutes\(body\.domain, \{\}, \{ pointer: true \}\)\)/);
});
