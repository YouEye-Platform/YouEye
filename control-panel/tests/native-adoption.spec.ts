// YE-210: the update check compares a native app's record with its market's manifest before it takes any lock. An
// app that is up to date takes no lock, so it never waits behind a user's operation and never announces one (the
// reconcile queue is not re-run, the route guard never sees it held); a changed one takes the locks as before.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { adoptChangedNativeManifests, type NativeAdoptionDeps, type NativeAdoptionOutcome } from '../src/lib/market/native-adoption';
import { AppUpdateJournalStore } from '../src/lib/market/update-journal';
import { isAppHeld, setAppOperationListener, withAppLifecycle, withUserOperationLockWait } from '../src/lib/market/update-admission';

type Plan = { digest: string };
type Outcome = NativeAdoptionOutcome & { version?: string };

/** Apps with a recorded digest and their market's digest; the locks are the real lifecycle lock on a temp store. */
function fixture(apps: Record<string, { recorded: string; market: string; native?: boolean }>, store: AppUpdateJournalStore) {
  const calls: string[] = [];
  const heard: string[] = [];
  const deps: NativeAdoptionDeps<Plan, Outcome> = {
    appIds: async () => Object.keys(apps),
    updateRunning: () => false,
    eligible: async (appId) => apps[appId].native !== false,
    plan: async (appId) => {
      calls.push(`plan ${appId} ${isAppHeld(appId) ? 'held' : 'free'}`);
      const app = apps[appId];
      return app.recorded === app.market ? null : { digest: app.market };
    },
    locked: (appId, work) => withAppLifecycle(appId, work, { store }),
    adopt: async (appId, plan) => {
      calls.push(`adopt ${appId} ${isAppHeld(appId) ? 'held' : 'free'}`);
      apps[appId].recorded = plan.digest;
      return { moved: true, version: plan.digest };
    },
    report: (appId, outcome) => calls.push(`report ${appId} ${outcome.moved}`),
    failed: (appId, error) => calls.push(`failed ${appId} ${error instanceof Error ? error.message : String(error)}`),
  };
  setAppOperationListener((appId, phase) => heard.push(`${appId}:${phase}`));
  return { deps, calls, heard };
}

function withStore<T>(work: (store: AppUpdateJournalStore) => Promise<T>): Promise<T> {
  const root = mkdtempSync(path.join(tmpdir(), 'youeye-ye210-'));
  return work(new AppUpdateJournalStore(path.join(root, 'journal'))).finally(() => {
    setAppOperationListener(undefined);
    rmSync(root, { recursive: true, force: true });
  });
}

test('an up-to-date native app takes no lock and announces no operation; a changed one takes the lock as before', () => withStore(async (store) => {
  const { deps, calls, heard } = fixture({ notes: { recorded: 'a', market: 'a' }, wiki: { recorded: 'b', market: 'c' } }, store);
  assert.deepEqual(await adoptChangedNativeManifests(deps), ['wiki']);
  assert.deepEqual(calls, [
    'plan notes free', // compared without a lock: nothing to do
    'plan wiki free', // changed: then the locks, and the plan again inside them
    'plan wiki held',
    'adopt wiki held',
    'report wiki true',
  ]);
  // The reconcile queue (and so the route guard's busy flag) hears only the app that changed.
  assert.deepEqual(heard, ['wiki:begin', 'wiki:end']);
  // The next check: both up to date, no lock at all.
  calls.length = 0;
  heard.length = 0;
  assert.deepEqual(await adoptChangedNativeManifests(deps), []);
  assert.deepEqual(calls, ['plan notes free', 'plan wiki free']);
  assert.deepEqual(heard, []);
}));

test('a check does not wait behind a user operation on an app that is up to date', () => withStore(async (store) => {
  const { deps, calls } = fixture({ notes: { recorded: 'a', market: 'a' } }, store);
  let releaseUser!: () => void;
  let userHasIt!: () => void;
  const holding = new Promise<void>(resolve => { userHasIt = resolve; });
  // A user's operation holds notes for as long as this test wants.
  const user = withUserOperationLockWait(() => withAppLifecycle('notes', () => new Promise<void>(resolve => {
    releaseUser = resolve;
    userHasIt();
  }), { store }));
  await holding;
  assert.equal(isAppHeld('notes'), true);
  const check = adoptChangedNativeManifests(deps);
  const finished = await Promise.race([check.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 500))]);
  releaseUser();
  await user;
  assert.equal(finished, true, 'the check finished while the user operation held the app');
  assert.deepEqual(calls, ['plan notes held']);
}));

test('a manifest the record already took while the check waited for the locks is not taken again', () => withStore(async (store) => {
  const apps = { wiki: { recorded: 'b', market: 'c' } };
  const { deps, calls } = fixture(apps, store);
  const locked = deps.locked;
  deps.locked = async (appId, work) => {
    apps.wiki.recorded = 'c'; // another operation took it meanwhile
    return locked(appId, work);
  };
  assert.deepEqual(await adoptChangedNativeManifests(deps), []);
  assert.deepEqual(calls, ['plan wiki free', 'plan wiki held']);
}));

test('an app that stops being eligible while the check waits for the locks is not adopted (YE-218)', () => withStore(async (store) => {
  const apps: Record<string, { recorded: string; market: string; native?: boolean }> = { wiki: { recorded: 'b', market: 'c' } };
  const { deps, calls } = fixture(apps, store);
  const locked = deps.locked;
  deps.locked = async (appId, work) => {
    apps.wiki.native = false; // say an uninstall that did not complete left its credentials pending meanwhile
    return locked(appId, work);
  };
  assert.deepEqual(await adoptChangedNativeManifests(deps), []);
  assert.deepEqual(calls, ['plan wiki free'], 'eligibility is decided again inside the locks; nothing adopted');
  assert.equal(apps.wiki.recorded, 'b');
}));

test('not native, an update running, and a failing app: skipped, stopped, and logged without stopping the pass', () => withStore(async (store) => {
  const { deps, calls, heard } = fixture({
    pointer: { recorded: 'a', market: 'b', native: false },
    notes: { recorded: 'a', market: 'b' },
    wiki: { recorded: 'b', market: 'c' },
  }, store);
  const plan = deps.plan;
  deps.plan = async (appId) => {
    if (appId === 'notes') throw new Error('market unreadable');
    return plan(appId);
  };
  assert.deepEqual(await adoptChangedNativeManifests(deps), ['wiki']);
  assert.deepEqual(calls, ['failed notes market unreadable', 'plan wiki free', 'plan wiki held', 'adopt wiki held', 'report wiki true']);
  assert.deepEqual(heard, ['wiki:begin', 'wiki:end']);
  // An app update running: the pass stops before the first app.
  calls.length = 0;
  deps.updateRunning = () => true;
  assert.deepEqual(await adoptChangedNativeManifests(deps), []);
  assert.deepEqual(calls, []);
}));

test('the update check wires the real plan outside the locks and the exclusion, lifecycle and network locks around it', () => {
  const source = readFileSync(path.join(__dirname, '../src/lib/market/updater.ts'), 'utf8');
  const body = source.slice(source.indexOf('export async function adoptNativeMarketManifests'), source.indexOf('async function nativeAdoptionPlan'));
  assert.match(body, /adoptChangedNativeManifests\(\{/);
  assert.match(body, /plan: nativeAdoptionPlan,/);
  assert.match(body, /locked: \(appId, work\) => oneUpdateAtATime\(\(\) => withAppLifecycle\(appId, \(\) => withAppNetworkOperationLock\(appId, 'update', work\)\)\)/);
  // The plan itself takes no lock (YE-210) and still compares the digests (YE-194).
  const plan = source.slice(source.indexOf('async function nativeAdoptionPlan'), source.indexOf('/** The last adoption tried per app'));
  assert.doesNotMatch(plan, /withAppLifecycle|withAppNetworkOperationLock|oneUpdateAtATime/);
  assert.match(plan, /nativeManifestChanged\(before, resolved\.reference\.digest\)/);
});

test('YE-212: a manifest the box cannot honour yet (needs-youeye, older-version) is reported and left; the record stays', () => withStore(async (store) => {
  const apps = { notes: { recorded: 'a', market: 'b' }, wiki: { recorded: 'c', market: 'd' } };
  const { deps, calls } = fixture(apps, store);
  let platform = '0.6.20';
  const adopt = deps.adopt;
  deps.adopt = async (appId, plan) => {
    if (appId === 'notes' && platform < '9.0.0') { calls.push(`adopt ${appId} refused`); return { moved: false, reason: 'needs-youeye' }; }
    if (appId === 'wiki') { calls.push(`adopt ${appId} refused`); return { moved: false, reason: 'older-version' }; }
    return adopt(appId, plan);
  };
  const reported: string[] = [];
  deps.report = (appId, outcome) => reported.push(`${appId} ${outcome.moved ? 'moved' : outcome.reason}`);
  assert.deepEqual(await adoptChangedNativeManifests(deps), []);
  assert.deepEqual(reported, ['notes needs-youeye', 'wiki older-version']);
  assert.deepEqual([apps.notes.recorded, apps.wiki.recorded], ['a', 'c'], 'both keep their record');
  // After the YouEye update (the attempt names the box's version, so the pass tries again) notes takes it; wiki stays.
  platform = '9.0.0';
  reported.length = 0;
  assert.deepEqual(await adoptChangedNativeManifests(deps), ['notes']);
  assert.deepEqual(reported, ['notes moved', 'wiki older-version']);
  assert.equal(apps.notes.recorded, 'b');
}));

test('YE-212: the real pass remembers a refusal (but a stopped app\'s) until the record, the market or the box\'s YouEye version changes', () => {
  const source = readFileSync(path.join(__dirname, '../src/lib/market/updater.ts'), 'utf8');
  const body = source.slice(source.indexOf('export async function adoptNativeMarketManifests'), source.indexOf('async function nativeAdoptionPlan'));
  // needs-youeye and older-version are remembered like contract-differs; the attempt names the box's YouEye version,
  // so a manifest that waited for a newer YouEye (or for Spine to say which it is) is tried again once that changes.
  assert.match(body, /if \(!outcome\.moved && outcome\.reason !== 'stopped'\) moveAttempts\(\)\.set\(appId, plan\.attempt\)/);
  assert.match(body, /else if \(outcome\.reason !== 'package-differs'\) \{\s*console\.warn\(`\[Market\] \$\{appId\} keeps its recorded manifest for now: \$\{outcome\.detail\}`\)/);
  assert.match(source, /registry\.__youeyeNativeMoveAttempts \?\?= new Map\(\)/);
  const plan = source.slice(source.indexOf('async function nativeAdoptionPlan'), source.indexOf('function moveAttempts'));
  assert.match(plan, /getPlatformContext\(\)\)\.then\(c => c\.version, \(\) => ''\)/);
  assert.match(plan, /const attempt = `[^`]*\\0\$\{resolved\.reference\.digest\}\\0\$\{platform\}`;/);
});
