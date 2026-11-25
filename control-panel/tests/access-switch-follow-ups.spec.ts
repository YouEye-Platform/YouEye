/**
 * YE-168, follow-ups to YE-154 found in the 0.6.19 gate review:
 * 1. "Try again" in Access settings reads the policy again, so a revision conflict resolves on the next try.
 * 2. A reinstall (by the dialog or by URL) keeps the policy the app kept unless the switch was changed.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { root } from './fixtures/market-world';
import {
  defaultOnlyUsers, explicitInstallPublicAccess, installAccessFields, installSwitchLocked, onlyUsersRequest, putOnlyUsers,
} from '../src/lib/market/public-access';
import { installWantsPublicAccess } from '../src/lib/market/engine';
import type { AdmissionPolicy } from '../../shared/admission';
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');

const policy = (revision: number, publicAccess = false): AdmissionPolicy => ({
  appId: 'nextcloud', installationId: '20000000-0000-4000-8000-000000000001', ownerId: '10000000-0000-4000-8000-000000000001',
  mode: 'owner', userIds: [], groupIds: [], revision, state: 'ready', publicAccess,
});

/** The Access route over a stored policy: a PUT with another revision than the stored one is a conflict (409). */
function accessServer(stored: AdmissionPolicy) {
  const puts: number[] = [];
  return {
    puts,
    get stored() { return stored; },
    load: async () => ({ policy: structuredClone(stored) }),
    put: async (body: ReturnType<typeof onlyUsersRequest>) => {
      puts.push(body.expectedRevision);
      if (body.expectedRevision !== stored.revision) throw new Error('Policy conflict, invalid principal, or administrator required');
      stored = { ...body.policy, revision: stored.revision + 1 };
      return { policy: structuredClone(stored) };
    },
  };
}

test('"Try again" reads the policy again: a revision conflict resolves on the next try', async () => {
  // The page read revision 3; another administrator saved since (revision 4).
  const server = accessServer(policy(4));
  const page = { policy: policy(3) };

  await assert.rejects(putOnlyUsers(server, page, false, false), /Policy conflict/);
  // Before YE-168 every retry sent revision 3 again and failed the same way until a reload.
  await assert.rejects(putOnlyUsers(server, page, false, false), /Policy conflict/);
  const retried = await putOnlyUsers(server, page, false, true);
  assert.equal(retried.policy!.publicAccess, true);
  assert.equal(retried.policy!.revision, 5);
  assert.deepEqual(server.puts, [3, 3, 4]);

  // The page wires its retry button to the fresh path, and only the retry.
  const component = read('src/components/market/app-access-settings.tsx');
  assert.match(component, /onClick=\{\(\) => void setOnlyUsers\(lastOnlyUsers \?\? false, true\)\}/);
  assert.match(component, /onCheckedChange=\{\(checked\) => void setOnlyUsers\(checked\)\}/);
  assert.match(component, /putOnlyUsers\(\{\s*load,/);
});

test('a reinstall starts from the kept policy and sends what the dialog showed', () => {
  const nextcloud = { supportsSSO: true, integrations: [] };
  const opened = { publicAccess: true };
  const closed = { publicAccess: false };

  // Nextcloud on byka: opened by the owner, then reinstalled. The switch starts off, and left alone it sends the
  // open state, which the install applies as no change (applyInstallPublicAccess finds nothing to change).
  assert.equal(defaultOnlyUsers({}, opened), false);
  assert.deepEqual(installAccessFields(nextcloud, { onlyUsers: defaultOnlyUsers({}, opened), youEyeSignIn: true, existing: opened }),
    { publicAccess: true, protectWithAccountLogin: true });
  // Turned on in the dialog: the administrator's explicit "only users" closes it.
  assert.equal(installAccessFields(nextcloud, { onlyUsers: true, youEyeSignIn: true, existing: opened }).publicAccess, false);
  // A kept closed policy of a self-protecting app stays closed unless the switch is turned off.
  assert.equal(defaultOnlyUsers({ publicAccess: true }, closed), true);
  assert.equal(installAccessFields(nextcloud, { onlyUsers: true, youEyeSignIn: true, existing: closed }).publicAccess, false);
  // No kept policy: the manifest's default, as before.
  assert.equal(defaultOnlyUsers({ publicAccess: true }, null), false);
  assert.equal(defaultOnlyUsers({}, null), true);

  // A gate-only app whose kept policy is open (opened before 0.6.19): not locked, so it can be closed; left open
  // the dialog sends no choice and the install keeps it.
  assert.equal(installSwitchLocked({ gateOnly: 'no-sign-in' }, opened), false);
  assert.equal(installSwitchLocked({ gateOnly: 'no-sign-in' }, closed), true);
  assert.equal(installSwitchLocked({ gateOnly: 'no-sign-in' }, null), true);
  assert.equal(installAccessFields({ supportsSSO: false, gateOnly: 'no-sign-in' }, { onlyUsers: false, youEyeSignIn: false, existing: opened }).publicAccess, undefined);
  assert.equal(installAccessFields({ supportsSSO: false, gateOnly: 'no-sign-in' }, { onlyUsers: true, youEyeSignIn: false, existing: opened }).publicAccess, false);
  assert.equal(installAccessFields({ supportsSSO: false, gateOnly: 'no-sign-in' }, { onlyUsers: false, youEyeSignIn: false, existing: null }).publicAccess, false);
});

test('the install applies no choice when none was sent (a URL reinstall without one)', () => {
  // install-url passes publicAccess only when the request had one (market-installed-safety.spec.ts). Without it the
  // engine has no explicit choice and a URL app has no manifest default, so its final step changes nothing.
  assert.equal(explicitInstallPublicAccess({}), undefined);
  assert.equal(installWantsPublicAccess({ sso: { callback: '/cb' } as never, credentials: [], env_mapping: {}, containers: [] },
    { sourceId: 'direct:abc' }), false);
  const engine = read('src/lib/market/engine.ts');
  assert.match(engine, /if \(!restoreOptions\?\.restoredIdentity && config\.admissionActorId && \(wantsPublicAccess \|\| accessChoice === false\)\)/);
});

test('the dialog takes the kept policy from the retained route and waits for it', () => {
  const route = read('src/app/api/market/app/[appId]/retained/route.ts');
  // Its mode too (YE-232): the dialog says who keeps access and hides its household choice.
  assert.match(route, /const existingAccess = policy \? \{ publicAccess: policy\.publicAccess === true, mode: policy\.mode \} : null;/);
  assert.match(route, /return NextResponse\.json\(\{ retained: false, existingAccess \}\)/);
  assert.match(route, /retained: true, version: retained\.installedVersion, existingAccess,/);
  const dialog = read('src/components/market/install-dialog.tsx');
  assert.match(dialog, /if \(existingAccess\) setOnlyUsers\(defaultOnlyUsers\(app, existingAccess\)\);/);
  assert.match(dialog, /installAccessFields\(app, \{ onlyUsers, youEyeSignIn: protectWithAccountLogin, existing: existingAccess \}\)/);
  // The install is refused until the retained answer is there, so the choice sent is the one shown.
  assert.match(dialog, /if \(!retainedData \|\| \(retainedData\.retained && \(!retainedData\.canAdopt \|\| !adoptRetainedData\)\)\) return;/);
});
