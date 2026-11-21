/**
 * A route that starts lifecycle work holds the platform lifecycle from its start, the market read included, so that
 * Spine's Control Panel restarter (spine/internal/api/control_restart.go, holdPlatformIdle) sees the request as work
 * and waits. The probe below is the restarter's: the admission gate, then the lifecycle lock, both exclusive and
 * without waiting.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as admission from '../src/lib/market/update-admission';
import { AppUpdateJournalStore } from '../src/lib/market/update-journal';
import { AppUpdateExecutorLock } from '../src/lib/market/update-executor-lock';
import { load } from './fixtures/market-world';

/** What Spine's restarter does: true when it could restart now (nothing holds the gate or the lifecycle lock). */
function restarterFindsIdle(directory: string): boolean {
  const result = spawnSync('/usr/bin/flock', [
    '--exclusive', '--nonblock', '--conflict-exit-code', '75', path.join(directory, 'core-admission.flock'),
    '/usr/bin/flock', '--exclusive', '--nonblock', '--conflict-exit-code', '75', path.join(directory, 'core-lifecycle.flock'),
    'true',
  ], { timeout: 5000 });
  assert.equal(result.error, undefined);
  assert.ok(result.status === 0 || result.status === 75, `flock exited ${result.status}`);
  return result.status === 0;
}

async function journal(work: (directory: string) => Promise<void>) {
  const root = mkdtempSync(path.join(tmpdir(), 'youeye-hold-'));
  const directory = path.join(root, 'journal');
  new AppUpdateJournalStore(directory);
  // The lock files as the lifecycle protocol keeps them (private, created by the first holder), before any probe.
  for (const name of ['core-admission.flock', 'core-lifecycle.flock']) AppUpdateExecutorLock.acquire(path.join(directory, name)).release();
  const previous = process.env.YOUEYE_APP_UPDATE_JOURNAL_DIR;
  process.env.YOUEYE_APP_UPDATE_JOURNAL_DIR = directory;
  try { await work(directory); }
  finally {
    if (previous === undefined) delete process.env.YOUEYE_APP_UPDATE_JOURNAL_DIR;
    else process.env.YOUEYE_APP_UPDATE_JOURNAL_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test('a held platform lifecycle keeps the restarter waiting; work run inside it reuses it past a closed gate', () =>
  journal(async (directory) => {
    assert.equal(restarterFindsIdle(directory), true);
    const hold = await admission.holdPlatformLifecycle(directory);
    assert.equal(restarterFindsIdle(directory), false, 'the restarter sees the hold as lifecycle work');
    // A System update's admission closes the gate while it waits for the lifecycle lock. Work the request starts
    // inside its hold must not need the gate again (it would wait for a writer that waits for it).
    const gate = AppUpdateExecutorLock.acquire(path.join(directory, 'core-admission.flock'), 'exclusive');
    try {
      assert.equal(await hold.run(() => admission.withPlatformLifecycle(async () => 'nested', directory)), 'nested');
    } finally { gate.release(); }
    hold.release();
    hold.release();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(restarterFindsIdle(directory), true, 'released when the request lets go');
  }));

test('a System update that owns the platform refuses the hold before anything runs', () =>
  journal(async (directory) => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(path.join(directory, 'core-reservation.json'), JSON.stringify({
      schema: 'youeye.core-lifecycle.v1', request_id: 'system-1', manifest_sha256: 'a'.repeat(64),
    }), { mode: 0o600 });
    await assert.rejects(admission.holdPlatformLifecycle(directory), { name: 'AppLifecycleAdmissionError' });
    assert.equal(restarterFindsIdle(directory), true, 'a refused hold keeps nothing');
  }));

test('the install route holds the lifecycle while it loads the catalog, through the install, and lets go after', () =>
  journal(async (directory) => {
    const resolving = deferred();
    const catalogAnswer = deferred();
    const installing = deferred();
    const finishInstall = deferred();
    let heldDuringInstall: boolean | null = null;
    const session = async () => ({ session: { username: 'cli', isAdmin: true, authMethod: 'cli' } });
    const route = load('src/app/api/market/install/route.ts', {
      'next/server': {},
      '@/lib/market/catalog': {
        isMarketAppUnavailable: () => false,
        // The market answers slowly (a fresh box whose DNS takes 10 s).
        resolveCatalogApp: async () => {
          resolving.resolve();
          await catalogAnswer.promise;
          return {
            manifest: { metadata: { id: 'demo', name: 'Demo', defaultSubdomain: 'demo' }, capabilities: {} },
            source: { id: 'official', name: 'Official', url: '' },
            reference: { path: 'apps/demo/youeye-app.yaml', repo: 'https://market.example.test/', branch: '', digest: 'd' },
          };
        },
      },
      '@/lib/market/source': { directAppRefusal: () => null, isMarketSourceConsentError: () => false, OFFICIAL_MARKET_SOURCE_ID: 'official' },
      '@/lib/market/engine': {
        installApp: async () => {
          // The install's own lifecycle locks reuse the request's admission.
          await admission.withPlatformLifecycle(async () => {
            heldDuringInstall = !restarterFindsIdle(directory);
            installing.resolve();
            await finishInstall.promise;
          });
        },
      },
      '@/lib/market/install-tracker': {
        startTracking: () => new AbortController(), trackEvent() {}, finishTracking() {}, logOperationFailure() {},
        sanitiseInstallEvent: (event: unknown) => event, sensitivitySafeInstallError: () => 'failed',
      },
      '@/lib/market/update-admission': admission,
      '@/lib/http/lifecycle-busy': { lifecycleRefusalResponse: () => null },
      '@/lib/health/notification-bridge': { sendNotificationToUI: async () => {} },
      '@/lib/events/emitter': { emitEvent() {} },
      '@/lib/settings': { settingsService: { getRaw: async () => ({ domain: 'box.example.test' }) } },
      '@/lib/health/issues': { hasOpenCriticalIssue: async () => null },
      '@/lib/auth/rbac': { requireAdmin: session },
      '@/lib/auth/session': { verifyCSRFToken: async () => true },
      '@/lib/admission/management': { admissionAdministrator: async () => '20000000-0000-4000-8000-000000000001' },
      '@/lib/identity/store': {}, '@/lib/market/install-ai-settings': {},
      '@/lib/market/direct-apps': { getDirectMarketApp: async () => null },
      '@/lib/market/installed-apps': { updateInstalledAppSource: async () => {} },
    });

    const answer = route.POST(new Request('https://cp.example.test/api', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ appId: 'demo' }),
    }));
    await resolving.promise;
    assert.equal(restarterFindsIdle(directory), false, 'the restart waits while the install is loading the catalog');
    catalogAnswer.resolve();
    const response: Response = await answer;
    assert.equal(response.status, 200);
    await installing.promise;
    assert.equal(heldDuringInstall, true);
    assert.equal(restarterFindsIdle(directory), false, 'the request still holds it after its handler returned');
    finishInstall.resolve();
    await response.text();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(restarterFindsIdle(directory), true, 'let go when the install has ended');
  }));

test('an install refused before its stream lets go of the hold', () =>
  journal(async (directory) => {
    const session = async () => ({ session: { username: 'cli', isAdmin: true, authMethod: 'cli' } });
    const route = load('src/app/api/market/install/route.ts', {
      'next/server': {},
      '@/lib/market/update-admission': admission,
      '@/lib/http/lifecycle-busy': { lifecycleRefusalResponse: () => null },
      '@/lib/market/install-tracker': { logOperationFailure() {} },
      '@/lib/health/issues': { hasOpenCriticalIssue: async () => ({ title: 'Disk failing' }) },
      '@/lib/auth/rbac': { requireAdmin: session },
      '@/lib/auth/session': { verifyCSRFToken: async () => true },
    });
    const response: Response = await route.POST(new Request('https://cp.example.test/api', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ appId: 'demo' }),
    }));
    assert.equal(response.status, 423);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(restarterFindsIdle(directory), true);
  }));

/** The restore route with its work replaced: `importing` and `restoring` are the moments a restart could arrive. */
function restoreRoute(directory: string, moments: {
  importSet?: () => Promise<void>; restore?: () => Promise<void>; points?: Array<Record<string, unknown>>;
}) {
  return load('src/app/api/backup/restore/route.ts', {
    'next/server': {},
    '@/lib/market/update-admission': admission,
    '@/lib/http/lifecycle-busy': { isLifecycleBusy: () => false },
    '@/lib/auth': { getSession: async () => ({ isAdmin: true }), verifyCSRFToken: async () => true },
    '@/lib/backup/full-restore': {
      restoreApps: async () => {
        // The restore's own lifecycle locks reuse the request's admission (a stream starts inside it).
        await admission.withPlatformLifecycle(async () => { await moments.restore?.(); }, directory);
      },
      fullRestore: async () => {}, rollBackRestore: async () => {}, holdRestoreServices: () => () => undefined,
    },
    '@/lib/backup/platform-backup': {
      validateBackupPassphrase: (value: unknown) => String(value),
      validateRestoreOperationId: (value: unknown) => String(value),
      withRestoreLock: (work: () => Promise<unknown>) => work(),
      writeRestoreStatus: async () => {}, readRestoreStatus: async () => null,
      recoveryImportErrorMessage: () => 'import failed', backupSetPath: () => '/nowhere',
    },
    '@/lib/spine/client': { spineClient: {
      getExternalRecoveryPoints: async () => ({ recovery_points: moments.points
        ?? [{ backup_id: 'backup-1', created_at: '2026-11-21T00:00:00Z', apps: ['notes'], size_bytes: 1 }] }),
      importBackupSet: async () => { await moments.importSet?.(); return { backup_path: '/nowhere/backup-1' }; },
    } },
    '@/lib/market/install-tracker': { logOperationFailure() {} },
  });
}

function restoreRequest() {
  return new Request('https://cp.example.test/api/backup/restore', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 't' },
    body: JSON.stringify({
      backupId: 'backup-1', mediaId: 'drive-1', confirm: true, passphrase: 'p', operationId: 'restore-1', appIds: ['notes'],
    }),
  });
}

test('the restore route holds the lifecycle while it imports the backup set, through the restore, and lets go after', () =>
  journal(async (directory) => {
    const importing = deferred();
    const imported = deferred();
    const restoring = deferred();
    const finishRestore = deferred();
    let nestedPastClosedGate = false;
    const route = restoreRoute(directory, {
      importSet: async () => { importing.resolve(); await imported.promise; },
      restore: async () => { nestedPastClosedGate = true; restoring.resolve(); await finishRestore.promise; },
    });
    const answer = route.POST(restoreRequest());
    await importing.promise;
    assert.equal(restarterFindsIdle(directory), false, 'the restart waits while the backup set is read from the drive');
    // A System update's admission closes the gate while it waits: the restore's locks must not need the gate again.
    const gate = AppUpdateExecutorLock.acquire(path.join(directory, 'core-admission.flock'), 'exclusive');
    let response: Response;
    try {
      imported.resolve();
      response = await answer;
      assert.equal(response.status, 200);
      await restoring.promise;
    } finally { gate.release(); }
    assert.equal(nestedPastClosedGate, true);
    assert.equal(restarterFindsIdle(directory), false, 'the request still holds it after its handler returned');
    finishRestore.resolve();
    assert.match(await response.text(), /"status":"completed"/);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(restarterFindsIdle(directory), true, 'let go when the restore has ended');
  }));

test('a restore refused before its stream, or by a System update that owns the platform, keeps no hold', () =>
  journal(async (directory) => {
    const missing: Response = await restoreRoute(directory, { points: [] }).POST(restoreRequest());
    assert.equal(missing.status, 404);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(restarterFindsIdle(directory), true);

    const failing: Response = await restoreRoute(directory, { importSet: async () => { throw new Error('drive gone'); } })
      .POST(restoreRequest());
    assert.equal(failing.status, 400);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(restarterFindsIdle(directory), true);

    const { writeFileSync } = await import('node:fs');
    writeFileSync(path.join(directory, 'core-reservation.json'), JSON.stringify({
      schema: 'youeye.core-lifecycle.v1', request_id: 'system-1', manifest_sha256: 'a'.repeat(64),
    }), { mode: 0o600 });
    let imports = 0;
    const owned: Response = await restoreRoute(directory, { importSet: async () => { imports++; } }).POST(restoreRequest());
    assert.equal(owned.status, 409);
    assert.match(await owned.text(), /System update owns the platform lifecycle/);
    assert.equal(imports, 0, 'nothing is imported');
  }));
