// YE-225: an uninstall that stops after it revoked the app's service credential (the dashboard down, so the
// revocation can't be published) leaves the record pending and the credential revoked. Revocation is final, so no
// reconcile can bring it back: the start refusal, the credential reconcile and Settings say "remove it again to
// finish" instead of offering a Reconcile that always fails.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { loadSource } from './fixtures/update-provider-harness';

const ROOT = process.env.CONTROL_PANEL_ROOT || process.cwd();

/** The real `lib/apps/unfinished-removal.ts` over a fake credential store. */
function removalModule(credentials: Record<string, { status: string; operationKind?: string } | 'broken'>) {
  return loadSource('lib/apps/unfinished-removal.ts', (name: string) => {
    if (name === './service-credential-store') return {
      appServiceCredentials: {
        // The lock-free read (Settings polls it); `projection` would take the app's lifecycle lock.
        projection: async () => { throw new Error('locked read used'); },
        observeCopyStatus: async (appId: string) => {
          const credential = credentials[appId];
          if (credential === 'broken') throw new Error('App credential requires repair');
          return credential ?? null;
        },
      },
    };
    return {};
  });
}

test('an unfinished removal: the record pending and the credential revoked, nothing else', async () => {
  const m = removalModule({
    sabnzbd: { status: 'revoked', operationKind: 'revoke' }, sonarr: { status: 'active', operationKind: 'provision' },
    restored: { status: 'revoked', operationKind: 'restore' }, broken: 'broken',
  });
  assert.equal(await m.removalUnfinished({ appId: 'sabnzbd', serviceCredentialState: 'pending' }), true);
  // A credential reconcile that can still work (active, or no store record) is not a removal.
  assert.equal(await m.removalUnfinished({ appId: 'sonarr', serviceCredentialState: 'pending' }), false);
  assert.equal(await m.removalUnfinished({ appId: 'radarr', serviceCredentialState: 'pending' }), false);
  // A deliberate revoke records `revoked` on the record: its own message ("deliberate reinstall") stays.
  assert.equal(await m.removalUnfinished({ appId: 'sabnzbd', serviceCredentialState: 'revoked' }), false);
  assert.equal(await m.removalUnfinished({ appId: 'sabnzbd', serviceCredentialState: 'ready' }), false);
  assert.equal(await m.removalUnfinished(null), false);
  // A failed server restore leaves a pending record and a revoked credential too, but a restore fence: Reconcile
  // recovers it, so it is not an unfinished removal (alpha.7 review).
  assert.equal(await m.removalUnfinished({ appId: 'restored', serviceCredentialState: 'pending' }), false);
  // A store that can't be read: no guess, the ordinary message.
  assert.equal(await m.removalUnfinished({ appId: 'broken', serviceCredentialState: 'pending' }), false);
  // Both forms, because the CLI deletes the data unless --keep-data, and the stopped removal may have kept it.
  assert.match(m.unfinishedRemovalMessage('sabnzbd'),
    /removal of sabnzbd did not finish.*youeye app remove sabnzbd --keep-data if you chose to keep its data, youeye app remove sabnzbd to delete it \(or Remove in Settings, which asks\)/);
});

/** The real start path of `lib/apps/lifecycle.ts`, with the record and the store faked. */
function lifecycle(meta: Record<string, unknown>, credentialStatus: string | null) {
  const removal = removalModule(credentialStatus ? { [String(meta.appId)]: { status: credentialStatus, operationKind: credentialStatus === 'revoked' ? 'revoke' : 'provision' } } : {});
  const exports = loadSource('lib/apps/lifecycle.ts', (name: string) => {
    if (name === '@/lib/market/metadata') return {
      readInstallMetadata: async () => meta, listReadableInstalledApps: async () => [meta], saveInstallMetadata: async () => undefined,
    };
    if (name === './container-order') return loadSource('lib/apps/container-order.ts', () => ({}));
    if (name === '@/lib/market/update-admission') return { withAppLifecycle: async (_appId: string, work: () => unknown) => work() };
    if (name === './app-reconciler') return { appReconciler: () => ({ resetCrashLoop: () => undefined }) };
    if (name === './unfinished-removal') return removal;
    if (name === 'crypto') return { randomUUID: () => 'fixture' };
    return {};
  });
  return (action: string) => exports.controlInstalledApp(meta.appId, action, 'owner');
}

test('start: an unfinished removal says how to finish it; an ordinary pending credential keeps its message', async () => {
  const meta = {
    appId: 'sabnzbd', serviceCredentialState: 'pending', enabled: false, desiredState: 'stopped',
    containers: [{ name: 'main', containerName: 'app-sabnzbd', type: 'oci', primary: true }],
  };
  await assert.rejects(lifecycle(meta, 'revoked')('start'), /removal of sabnzbd did not finish.*youeye app remove sabnzbd/);
  await assert.rejects(lifecycle(meta, 'revoked')('restart'), /removal of sabnzbd did not finish/);
  await assert.rejects(lifecycle(meta, 'active')('start'), /requires credential reconciliation before start/);
});

/** The real POST of `app/api/market/credentials/[appId]/route.ts`. */
function credentialRoute(meta: Record<string, unknown> | null, credentialStatus: string | null, operationKind?: string) {
  const operated: string[] = [];
  const kind = operationKind ?? (credentialStatus === 'revoked' ? 'revoke' : 'provision');
  const removal = removalModule(credentialStatus && meta ? { [String(meta.appId)]: { status: credentialStatus, operationKind: kind } } : {});
  const exports = loadSource('app/api/market/credentials/[appId]/route.ts', (name: string) => {
    if (name === '@/lib/auth/rbac') return { requireAdmin: async () => ({ session: { isAdmin: true } }) };
    if (name === '@/lib/auth/session') return { verifyCSRFToken: async () => true };
    if (name === '@/lib/market/update-admission') return { withUserOperationLockWait: (work: () => unknown) => work() };
    if (name === '@/lib/http/lifecycle-busy') return { lifecycleBusyResponse: () => null };
    if (name === '@/lib/market/install-tracker') return { logOperationFailure: () => undefined };
    if (name === '@/lib/apps/service-credential-operations') return {
      operateAppCredential: async (appId: string, operation: { action: string }) => {
        operated.push(`${appId}:${operation.action}`);
        throw new Error('App credential requires repair');
      },
    };
    if (name === '@/lib/market/metadata') return { readInstallMetadata: async () => meta };
    if (name === '@/lib/apps/unfinished-removal') return removal;
    return {};
  }, { Response });
  const post = (action: string) => exports.POST(
    new Request('http://cp.test/api/market/credentials/sabnzbd', {
      method: 'POST', headers: { 'x-csrf-token': 'fixture' }, body: JSON.stringify({ action }),
    }),
    { params: Promise.resolve({ appId: 'sabnzbd' }) },
  );
  return { post, operated };
}

test('reconcile: an unfinished removal answers what finishes it, and runs no reconcile that cannot work', async () => {
  const unfinished = credentialRoute({ appId: 'sabnzbd', serviceCredentialState: 'pending' }, 'revoked');
  const response = await unfinished.post('reconcile');
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.code, 'removal-unfinished');
  assert.match(body.error, /removal of sabnzbd did not finish.*youeye app remove sabnzbd/);
  assert.deepEqual(unfinished.operated, []);
  // Any other pending credential is reconciled as before (and its failure answers as before).
  const ordinary = credentialRoute({ appId: 'sabnzbd', serviceCredentialState: 'pending' }, 'active');
  const answer = await ordinary.post('reconcile');
  assert.equal(answer.status, 409);
  assert.match((await answer.json()).error, /App service integration is pending/);
  assert.deepEqual(ordinary.operated, ['sabnzbd:reconcile']);
  // After a failed server restore (a restore fence, operationKind restore) Reconcile is what recovers the app: it runs.
  const restored = credentialRoute({ appId: 'sabnzbd', serviceCredentialState: 'pending' }, 'revoked', 'restore');
  await restored.post('reconcile');
  assert.deepEqual(restored.operated, ['sabnzbd:reconcile']);
});

test('Settings: no Reconcile button for an unfinished removal, its own status line, and the Remove section stays', () => {
  const source = readFileSync(path.join(ROOT, 'src/components/settings-shell/apps-client.tsx'), 'utf8');
  assert.match(source, /const canReconcile = isAdmin && credentialState === "pending" && !removalUnfinished;/);
  assert.match(source, /\{canReconcile && \(\s*<Button variant="outline" onClick=\{\(\) => void reconcileCredentials\(\)\}/);
  assert.doesNotMatch(source, /isAdmin && credentialState === "pending" && \(/, 'no other path shows Reconcile');
  assert.match(source, /removalUnfinished \? \{ text: translateInterface\("m176648d8341c"\), serious: true \}/);
  assert.match(source, /isAdmin && isUserApp && <AppUninstall appId=\{appId\} appName=\{title\} \/>/);
  for (const lang of ['en', 'ru', 'es', 'de', 'fr']) {
    const catalogue = JSON.parse(readFileSync(path.join(ROOT, `messages/${lang}.json`), 'utf8'));
    assert.ok(catalogue.interface.m176648d8341c, `${lang} has the line`);
  }
  // The unified API marks it, only for a record that says pending.
  const unified = readFileSync(path.join(ROOT, 'src/app/api/apps/unified/route.ts'), 'utf8');
  assert.match(unified, /\.filter\(\(meta\) => meta\.serviceCredentialState === 'pending'\)/);
  assert.match(unified, /unfinishedRemovals\.has\(meta\.appId\) \? \{ removalUnfinished: true \}/);
});
