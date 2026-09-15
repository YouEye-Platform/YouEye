import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createDeploymentJobStream,
  getDeploymentJob,
  startDeploymentJob,
} from '../src/lib/infrastructure/deployment-jobs';
import { sanitizeDeploymentDetail } from '../src/lib/infrastructure/deployment-safety';

async function useTemporaryState(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'youeye-deployment-jobs-'));
  process.env.YOUEYE_DEPLOYMENT_STATE_DIR = dir;
  return dir;
}

async function waitForTerminal(id: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = await getDeploymentJob(id);
    if (state && state.status !== 'running') return state;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`job ${id} did not reach a terminal state`);
}

test('early progress-stream cancellation does not cancel the durable deployment job', async () => {
  const dir = await useTemporaryState();
  const id = `deploy-early-eof-${Date.now()}`;
  let finish!: () => void;
  const held = new Promise<void>((resolve) => { finish = resolve; });

  await startDeploymentJob({
    id,
    kind: 'deploy',
    hostIP: '192.0.2.10',
    runner: async (_hostIP, emit) => {
      emit({ step: 2, totalSteps: 4, status: 'running', message: 'Deploying Caddy' });
      await held;
      emit({ step: 4, totalSteps: 4, status: 'success', message: 'UI deployed' });
    },
  });

  const reader = createDeploymentJobStream(id).getReader();
  const first = await reader.read();
  assert.equal(first.done, false);
  await reader.cancel('simulated Spine disconnect');
  finish();

  const state = await waitForTerminal(id);
  assert.equal(state.status, 'succeeded');
  assert.equal(state.events.at(-1)?.terminal, true);
  assert.equal(state.events.at(-1)?.message, 'Infrastructure deployment reached durable success');
  assert.equal((await stat(join(dir, `${id}.json`))).mode & 0o777, 0o600);
});

test('duplicate POST identity attaches to one mutation instead of running it twice', async () => {
  await useTemporaryState();
  const id = `deploy-duplicate-${Date.now()}`;
  let runs = 0;
  let finish!: () => void;
  const held = new Promise<void>((resolve) => { finish = resolve; });
  const runner = async () => {
    runs += 1;
    await held;
  };

  await startDeploymentJob({ id, kind: 'deploy', hostIP: '192.0.2.11', runner });
  await startDeploymentJob({ id, kind: 'deploy', hostIP: '192.0.2.11', runner });
  assert.equal(runs, 1);
  finish();
  assert.equal((await waitForTerminal(id)).status, 'succeeded');
});

test('initial durable-write failure releases the active reservation and permits a safe retry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'youeye-deployment-first-write-'));
  const blocked = join(root, 'blocked-by-file');
  await writeFile(blocked, 'not a directory');
  process.env.YOUEYE_DEPLOYMENT_STATE_DIR = blocked;

  const id = `deploy-first-write-${Date.now()}`;
  let runs = 0;
  const runner = async () => { runs += 1; };
  await assert.rejects(
    startDeploymentJob({ id, kind: 'deploy', hostIP: '192.0.2.15', runner }),
  );
  assert.equal(runs, 0, 'the mutation must not start before its initial state is durable');

  const retryDir = join(root, 'retry');
  process.env.YOUEYE_DEPLOYMENT_STATE_DIR = retryDir;
  await startDeploymentJob({ id, kind: 'deploy', hostIP: '192.0.2.15', runner });
  assert.equal((await waitForTerminal(id)).status, 'succeeded');
  assert.equal(runs, 1, 'retry must run exactly one mutation');
});

test('genuine step failure is durable, terminal, bounded, and credential-redacted', async () => {
  const dir = await useTemporaryState();
  const id = `deploy-failure-${Date.now()}`;
  const unsafe = `password=hunter2 token=abc123 ${'x'.repeat(3000)}`;

  await startDeploymentJob({
    id,
    kind: 'deploy',
    hostIP: '192.0.2.12',
    runner: async (_hostIP, emit) => {
      emit({ step: 3, totalSteps: 4, status: 'error', message: 'Pi-Hole deployment failed', detail: unsafe });
      throw new Error(unsafe);
    },
  });

  const state = await waitForTerminal(id);
  assert.equal(state.status, 'failed');
  assert.equal(state.failure?.step, 3);
  assert.match(state.failure?.detail || '', /password=<redacted>/);
  assert.match(state.failure?.detail || '', /token=<redacted>/);
  assert.doesNotMatch(state.failure?.detail || '', /hunter2|abc123/);
  assert.ok((state.failure?.detail?.length || 0) <= 1601);
  assert.doesNotMatch(await readFile(join(dir, `${id}.json`), 'utf8'), /hunter2|abc123/);
});

test('a persisted running job from a previous process is reported indeterminate', async () => {
  const dir = await useTemporaryState();
  const id = `deploy-orphan-${Date.now()}`;
  const now = new Date().toISOString();
  await writeFile(join(dir, `${id}.json`), `${JSON.stringify({
    id,
    kind: 'deploy',
    hostIP: '192.0.2.13',
    status: 'running',
    ownerPID: process.pid + 100000,
    createdAt: now,
    updatedAt: now,
    events: [{ step: 2, totalSteps: 4, status: 'running', message: 'Deploying Caddy', sequence: 1 }],
  })}\n`, { mode: 0o600 });

  const state = await getDeploymentJob(id);
  assert.equal(state?.status, 'indeterminate');
  assert.match(state?.failure?.detail || '', /reconciliation/);
});

test('completed jobs replay their terminal state and close without controller errors', async () => {
  await useTemporaryState();
  const id = `deploy-complete-before-stream-${Date.now()}`;
  await startDeploymentJob({
    id,
    kind: 'deploy',
    hostIP: '192.0.2.14',
    runner: async (_hostIP, emit) => {
      emit({ step: 4, totalSteps: 4, status: 'success', message: 'UI deployed' });
    },
  });
  await waitForTerminal(id);

  const reader = createDeploymentJobStream(id).getReader();
  const chunks: string[] = [];
  const decoder = new TextDecoder();
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    chunks.push(decoder.decode(result.value));
  }
  assert.match(chunks.join(''), /durable success/);
  await reader.cancel();
});

test('diagnostic sanitization removes bearer credentials', () => {
  const sanitized = sanitizeDeploymentDetail('Authorization: Bearer abc.def.ghi');
  assert.match(sanitized, /Authorization=<redacted>/);
  assert.doesNotMatch(sanitized, /abc\.def\.ghi/);
});
