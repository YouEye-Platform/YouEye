/**
 * `youeye user delete <user> --retain-data` (DELETE /api/people/<id>?retainData=true): the data apps keep private to
 * the user is retained (quarantined) in every app, the per-app "retain" choice of an app's Access settings, then the
 * user is deleted. A user who administers or installed an app is refused with nothing changed; refusals are 409.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import * as admission from '../../shared/admission';
import { load } from './fixtures/market-world';

const USER = '30000000-0000-4000-8000-000000000003';
const ADMIN = '20000000-0000-4000-8000-000000000002';

type Resource = { app_id: string; revision: number; app_wide: boolean };
function management(state: {
  administers?: string[]; resources?: Resource[];
  /** What the second read (under the locks) finds, when it differs from the first. */
  underLocks?: { administers?: string[]; resources?: Resource[] };
  /** An app whose lifecycle is busy. */
  busy?: string;
}) {
  const quarantined: Array<Record<string, unknown>> = [];
  const locked: string[] = [];
  let held = false;
  const module = load('src/lib/admission/management.ts', {
    '../market/update-admission': {
      withAppLifecycle: async (_appId: string, work: () => unknown) => work(),
      withAppLifecycles: async (appIds: string[], work: () => unknown) => {
        if (state.busy && appIds.includes(state.busy)) throw Object.assign(new Error('busy'), { name: 'AppLifecycleBusyError' });
        locked.push(...appIds);
        held = true;
        if (state.underLocks) Object.assign(state, state.underLocks);
        try { return await work(); } finally { held = false; }
      },
    },
    '@/lib/identity/store': {
      ensureIdentitySchema: async () => {},
      identitySql: (value: unknown) => `'${String(value)}'`,
      identityRows: async (query: string) => query.includes('FROM admission_policies\n')
        || /SELECT app_id FROM admission_policies/.test(query)
        ? (state.administers ?? []).map((app_id) => ({ app_id }))
        : state.resources ?? [],
      identityStatementRows: async (query: string) => {
        const app = /p\.app_id = '([^']+)'/.exec(query)?.[1];
        const revision = /p\.revision = '([^']+)'/.exec(query)?.[1];
        assert.equal(held, true, 'retained only under the locks');
        quarantined.push({ app, revision, principal: query.includes(`'${USER}'::uuid`) });
        return [{ installation_id: 'i' }];
      },
    },
    '../../../../shared/admission': admission,
  });
  return { module, quarantined, locked, held: () => held };
}

test('retaining a user\'s private data quarantines it in every app that keeps some, installed or retained', async () => {
  const { module, quarantined } = management({ resources: [
    { app_id: 'notes', revision: 4, app_wide: false }, { app_id: 'wiki', revision: 2, app_wide: false },
  ] });
  assert.deepEqual(await module.retainUserPrivateData(USER, ADMIN), ['notes', 'wiki']);
  assert.deepEqual(quarantined, [
    { app: 'notes', revision: '4', principal: true }, { app: 'wiki', revision: '2', principal: true },
  ]);
});

test('a user who administers or installed an app is refused before anything is retained', async () => {
  for (const state of [
    { administers: ['photos'], resources: [{ app_id: 'notes', revision: 1, app_wide: false }] },
    { resources: [{ app_id: 'notes', revision: 1, app_wide: false }, { app_id: 'photos', revision: 3, app_wide: true }] },
  ]) {
    const { module, quarantined } = management(state);
    await assert.rejects(module.retainUserPrivateData(USER, ADMIN),
      (error: Error) => error.name === 'IdentityDispositionError' && /administers or installed photos/.test(error.message));
    assert.deepEqual(quarantined, [], 'nothing is retained');
  }
});

test('a refusal leaves nothing retained: every lock first, the user\'s data read again under them, then the deletion', async () => {
  const resources = [{ app_id: 'notes', revision: 4, app_wide: false }, { app_id: 'wiki', revision: 2, app_wide: false }];

  const busy = management({ resources, busy: 'wiki' });
  await assert.rejects(busy.module.retainUserPrivateData(USER, ADMIN), { name: 'AppLifecycleBusyError' });
  assert.deepEqual(busy.quarantined, [], 'a busy second app refuses before the first app\'s data is retained');

  // Under the locks the user turns out to have installed an app meanwhile, or to have data in one more app.
  for (const underLocks of [
    { resources: [...resources, { app_id: 'photos', revision: 1, app_wide: true }] },
    { resources: [...resources, { app_id: 'mail', revision: 1, app_wide: false }] },
  ]) {
    const changed = management({ resources, underLocks });
    let deleted = false;
    await assert.rejects(changed.module.retainUserPrivateData(USER, ADMIN, async () => { deleted = true; }),
      { name: 'IdentityDispositionError' });
    assert.deepEqual(changed.quarantined, []);
    assert.equal(deleted, false);
  }

  // The revision retained against is the one read under the locks; the deletion runs under them, after the last app.
  const fresh = management({ resources, underLocks: { resources: [{ ...resources[0], revision: 5 }, resources[1]] } });
  const order: string[] = [];
  assert.deepEqual(await fresh.module.retainUserPrivateData(USER, ADMIN, async () => {
    order.push(`delete held=${fresh.held()} after=${fresh.quarantined.length}`);
  }), ['notes', 'wiki']);
  assert.deepEqual(fresh.locked, ['identity', 'notes', 'wiki'], 'YouEye ID and every app, before anything');
  assert.equal(fresh.quarantined[0].revision, '5');
  assert.deepEqual(order, ['delete held=true after=2']);
});

function peopleRoute(options: { retain?: () => Promise<string[]>; deleteUser?: () => Promise<void>; admin?: string | null } = {}) {
  const calls: string[] = [];
  const dispositionError = (message: string) => Object.assign(new Error(message), { name: 'IdentityDispositionError' });
  const route = load('src/app/api/people/[id]/route.ts', {
    'next/server': { NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) } },
    '@/lib/auth': { getSession: async () => ({ isAdmin: true, authMethod: 'cli' }), verifyCSRFToken: async () => true },
    '@/lib/identity/provider': { deleteUser: async () => { calls.push('delete'); await options.deleteUser?.(); } },
    '@/lib/identity/store': {
      assertIdentityDisposition: async () => { calls.push('check'); },
      isIdentityDispositionError: (error: unknown) => error instanceof Error && error.name === 'IdentityDispositionError',
    },
    '@/lib/admission/management': {
      admissionAdministrator: async () => options.admin === undefined ? ADMIN : options.admin,
      retainUserPrivateData: async (_id: string, _actor: string, thenDelete: () => Promise<void>) => {
        calls.push('retain');
        const retained = options.retain ? await options.retain() : ['notes'];
        await thenDelete();
        return retained;
      },
    },
    '@/lib/market/update-admission': { withUserOperationLockWait: (work: () => unknown) => Promise.resolve().then(work) },
    '@/lib/http/lifecycle-busy': {
      lifecycleRefusalResponse: (error: unknown) => error instanceof Error && error.name === 'AppLifecycleBusyError'
        ? Response.json({ code: 'operation_in_progress' }, { status: 409 }) : null,
    },
  });
  const remove = (query = '') => {
    const url = new URL(`https://cp.example.test/api/people/${USER}${query}`);
    const request = Object.assign(new Request(url, { method: 'DELETE', headers: { 'X-CSRF-Token': 't' } }), { nextUrl: url });
    return route.DELETE(request, { params: Promise.resolve({ id: USER }) });
  };
  return { remove, calls, dispositionError };
}

test('DELETE /api/people/<id>: retainData retains first, a refusal is 409 with its reason, plain delete is unchanged', async () => {
  const plain = peopleRoute();
  assert.equal((await plain.remove()).status, 200);
  assert.deepEqual(plain.calls, ['delete'], 'without retainData nothing is retained');

  const retaining = peopleRoute();
  const answer = await retaining.remove('?retainData=true');
  assert.equal(answer.status, 200);
  assert.deepEqual((await answer.json()).retainedDataApps, ['notes']);
  assert.deepEqual(retaining.calls, ['check', 'retain', 'delete']);

  const refused = peopleRoute({ deleteUser: async () => {
    throw Object.assign(new Error('Transfer application administration and explicitly retain/quarantine or dispose of private data before deleting this user'), { name: 'IdentityDispositionError' });
  } });
  const refusal = await refused.remove();
  assert.equal(refusal.status, 409);
  assert.equal((await refusal.json()).code, 'disposition_required');

  const installer = peopleRoute({ retain: async () => {
    throw Object.assign(new Error('This user administers or installed photos.'), { name: 'IdentityDispositionError' });
  } });
  const blocked = await installer.remove('?retainData=true');
  assert.equal(blocked.status, 409);
  assert.match((await blocked.json()).error, /administers or installed photos/);
  assert.deepEqual(installer.calls, ['check', 'retain'], 'not deleted');

  const busy = peopleRoute({ retain: async () => { throw Object.assign(new Error('busy'), { name: 'AppLifecycleBusyError' }); } });
  const waiting = await busy.remove('?retainData=true');
  assert.equal(waiting.status, 409);
  assert.equal((await waiting.json()).code, 'operation_in_progress');
  assert.deepEqual(busy.calls, ['check', 'retain'], 'not deleted');

  const noAdmin = peopleRoute({ admin: null });
  assert.equal((await noAdmin.remove('?retainData=true')).status, 403);
  assert.deepEqual(noAdmin.calls, []);
});
