import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

let root: string;
let tracker: typeof import('../src/lib/market/install-tracker');

test.before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'youeye-install-operations-'));
  process.env.YOUEYE_INSTALL_OPERATIONS_DIR = root;
  tracker = await import('../src/lib/market/install-tracker');
});

test.after(async () => {
  await rm(root, { recursive: true, force: true });
});

test('operation progress survives disconnect without persisting diagnostic secrets', async () => {
  tracker.startTracking('durable-app', 'Durable App');
  tracker.trackEvent('durable-app', {
    step: 1,
    totalSteps: 2,
    status: 'error',
    message: 'Bearer unsafe-token password=unsafe-password',
    detail: 'random-credential-value',
    errorContext: {
      url: 'https://user:password@example.test/path?token=unsafe-query#fragment',
      responseBody: 'unsafe-response-value',
      resolvedVars: { API_KEY: 'unsafe-resolved-value' },
      suggestion: 'authorization=unsafe-header',
    },
  });
  tracker.finishTracking('durable-app', 'unsafe-terminal-error');

  const file = path.join(root, 'durable-app.json');
  const record = await readFile(file, 'utf8');
  for (const forbidden of [
    'unsafe-token', 'unsafe-password', 'random-credential-value', 'unsafe-query',
    'unsafe-response-value', 'unsafe-resolved-value', 'unsafe-header', 'unsafe-terminal-error',
  ]) {
    assert.equal(record.includes(forbidden), false, `durable record leaked ${forbidden}`);
  }
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal(tracker.getTrackedInstall('durable-app')?.done, true);
});

test('public install failures expose actionable network capacity but hide arbitrary causes', () => {
  const capacity = new Error('App target requires 31 addresses, but /27 provides 30 usable addresses');
  capacity.name = 'AppNetworkCapacityError';
  assert.match(
    tracker.sensitivitySafeInstallError(new Error('install failed', { cause: capacity })),
    /requires 31 addresses/,
  );
  assert.doesNotMatch(
    tracker.sensitivitySafeInstallError(new Error('dependency returned secret=unsafe-value')),
    /unsafe-value/,
  );

  const packagePolicy = new Error('App package contains a symbolic link that leaves the package');
  packagePolicy.name = 'MarketNativeArtifactPolicyError';
  assert.match(
    tracker.sensitivitySafeInstallError(new Error('install failed', { cause: packagePolicy })),
    /symbolic link that leaves the package/,
  );
});

test('startup recovery closes interrupted records and preserves the durable history', async () => {
  const now = Date.now();
  await writeFile(path.join(root, 'interrupted-app.json'), `${JSON.stringify({
    schema: 'youeye.install-operation/1',
    appId: 'interrupted-app',
    appName: 'Interrupted App',
    events: [],
    done: false,
    startedAt: now,
    updatedAt: now,
  })}\n`, { mode: 0o600 });

  assert.deepEqual(tracker.recoverInterruptedInstalls(), ['interrupted-app']);
  const recovered = tracker.getTrackedInstall('interrupted-app');
  assert.equal(recovered?.done, true);
  assert.match(recovered?.error ?? '', /restarted before the operation reached a terminal state/);
});

test('reconciliation preserves a live operation owned by another module instance', async () => {
  tracker.startTracking('owner-seed', 'Owner Seed');
  const seed = JSON.parse(await readFile(path.join(root, 'owner-seed.json'), 'utf8')) as {
    runtimeOwner?: string;
  };
  assert.match(seed.runtimeOwner ?? '', /^\d+:\d+$/);

  const now = Date.now();
  await writeFile(path.join(root, 'same-runtime-app.json'), `${JSON.stringify({
    schema: 'youeye.install-operation/1',
    appId: 'same-runtime-app',
    appName: 'Same Runtime App',
    events: [],
    done: false,
    startedAt: now,
    updatedAt: now,
    runtimeOwner: seed.runtimeOwner,
  })}\n`, { mode: 0o600 });

  assert.deepEqual(tracker.recoverInterruptedInstalls(), []);
  assert.equal(tracker.getTrackedInstall('same-runtime-app')?.done, false);
  tracker.finishTracking('owner-seed');
  tracker.finishTracking('same-runtime-app');
});

test('reconciliation corrects an interrupted operation when durable app state proves completion', async () => {
  const now = Date.now();
  await writeFile(path.join(root, 'completed-app.json'), `${JSON.stringify({
    schema: 'youeye.install-operation/1',
    appId: 'completed-app',
    appName: 'Completed App',
    events: [],
    done: false,
    startedAt: now,
    updatedAt: now,
  })}\n`, { mode: 0o600 });
  assert.deepEqual(tracker.recoverInterruptedInstalls(), ['completed-app']);
  assert.equal(tracker.reconcileCompletedInstallOperation('completed-app'), true);
  const corrected = tracker.getTrackedInstall('completed-app');
  assert.equal(corrected?.done, true);
  assert.equal(corrected?.error, undefined);
  assert.equal(tracker.reconcileCompletedInstallOperation('completed-app'), false);
});

test('corrupt operation state fails closed instead of being reset', async () => {
  const corrupt = path.join(root, 'corrupt-app.json');
  await writeFile(corrupt, '{"schema":"wrong"}\n', { mode: 0o666 });
  await chmod(corrupt, 0o600);
  assert.throws(
    () => tracker.getAllActiveInstalls(),
    /Durable install operation for corrupt-app is corrupt/,
  );
  assert.equal((await readFile(corrupt, 'utf8')).includes('"schema":"wrong"'), true);
});

test('insecure durable operation permissions fail closed', async () => {
  const now = Date.now();
  const insecure = path.join(root, 'insecure-app.json');
  await writeFile(insecure, `${JSON.stringify({
    schema: 'youeye.install-operation/1',
    appId: 'insecure-app',
    appName: 'Insecure App',
    events: [],
    done: true,
    startedAt: now,
    updatedAt: now,
  })}\n`, { mode: 0o600 });
  await chmod(insecure, 0o644);
  assert.throws(
    () => tracker.getTrackedInstall('insecure-app'),
    /corrupt or insecure/,
  );
});

test('insecure durable operation directory fails closed', async () => {
  await chmod(root, 0o755);
  assert.throws(
    () => tracker.getAllActiveInstalls(),
    /directory must be a real directory with mode 0700/,
  );
  await chmod(root, 0o700);
});

const imageDnsFailure = () => new Error('App installation failed (installer stage failed); rollback verified clean', {
  cause: new Error('Operation failed: Failed getting remote image info: Failed to run: skopeo --insecure-policy inspect '
    + 'docker://docker.io/docuseal/docuseal@sha256:' + '0'.repeat(64) + ' --no-tags: exit status 1 (Get '
    + '"https://production.cloudfront.docker.com/registry-v2/blob?Expires=1700000000&Signature=unsafe-signature&Key-Pair-Id=K1": '
    + 'dial tcp: lookup production.cloudfront.docker.com: i/o timeout) Bearer unsafe-bearer password=unsafe-password'),
});

test('well-known install failures map to short safe messages; unknown causes stay generic', () => {
  assert.equal(tracker.sensitivitySafeInstallError(imageDnsFailure()),
    'Downloading the app image failed (network/DNS timeout); try again');
  assert.equal(tracker.sensitivitySafeInstallError(new Error('App installation failed', {
    cause: new Error('Operation failed: Failed getting remote image info: Failed to run: skopeo inspect docker://ghcr.io/x/y:1: manifest unknown'),
  })), 'The app image is not available from its registry');
  const busy = new Error('Another operation on this app is in progress; try again in a moment');
  busy.name = 'AppLifecycleBusyError';
  assert.equal(tracker.sensitivitySafeInstallError(new Error('wrapped', { cause: busy })),
    'Another operation on this app is in progress; try again in a moment');
  assert.equal(tracker.sensitivitySafeInstallError(new Error('App update executor lock is busy')),
    'Another operation on this app is in progress; try again in a moment');
  assert.equal(tracker.sensitivitySafeInstallError(new Error('Installation cancelled by user')),
    'Installation was cancelled');
  assert.match(tracker.sensitivitySafeInstallError(new Error('Postgres said password=unsafe-value')),
    /^Installation failed; use the supported Health/);
  // A DNS-looking failure without image context is not claimed to be an image download.
  assert.match(tracker.sensitivitySafeInstallError(new Error('lookup id.example: i/o timeout')),
    /^Installation failed; use the supported Health/);
});

test('known safe messages reach the durable record; other terminal errors stay generic', () => {
  tracker.startTracking('busy-app', 'Busy App');
  tracker.finishTracking('busy-app', 'Another operation on this app is in progress; try again in a moment');
  assert.equal(tracker.getTrackedInstall('busy-app')?.error,
    'Another operation on this app is in progress; try again in a moment');
});

test('the full cause chain is logged once, redacted and without URL query strings', () => {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try { tracker.logOperationFailure('Install of docuseal', imageDnsFailure()); }
  finally { console.error = original; }
  assert.equal(lines.length, 1);
  const [line] = lines;
  assert.match(line, /Install of docuseal failed: App installation failed .* <cause> Operation failed: Failed getting remote image info/);
  assert.match(line, /i\/o timeout/);
  assert.match(line, /https:\/\/production\.cloudfront\.docker\.com\/registry-v2\/blob"/);
  for (const forbidden of ['unsafe-signature', 'Expires=', 'Key-Pair-Id', 'unsafe-bearer', 'unsafe-password']) {
    assert.equal(line.includes(forbidden), false, `log leaked ${forbidden}`);
  }
});
