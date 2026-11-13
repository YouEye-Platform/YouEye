import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import type { NamesLifecycleState } from '../src/lib/youeye-names/state';

const code = ts.transpileModule(
  readFileSync(new URL('../src/app/api/tls/youeye-names/status/route.ts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;

const privateKeySentinel = 'synthetic-private-key-for-status-response-regression';
const csrSentinel = 'synthetic-certificate-request-for-status-response-regression';
const futureSecretSentinel = 'synthetic-future-private-field-for-status-response-regression';
const now = '2026-06-01T12:00:00.000Z';
const certificate = {
  fingerprint: 'a'.repeat(64),
  provider: 'google-public-ca' as const,
  issuedAt: now,
  expiresAt: '2026-07-01T12:00:00.000Z',
};
const terms = { version: 'terms-2026', summary: 'Certificate disclosure', certificateTransparencyRequired: true };
const readiness = { installation: { canProceedNow: true, state: 'ready', reasonCodes: [] } };

type FixtureState = NamesLifecycleState & { futurePrivateField: string };

function lifecycle(): FixtureState {
  return {
    schemaVersion: 1,
    service: { id: 'names-service', canonicalOrigin: 'https://names.example.test', apiVersion: 'v1', managedZone: 'example.test' },
    name: 'quiet-forest',
    fqdn: 'quiet-forest.example.test',
    status: 'provisioning',
    provisioning: {
      stage: 'certificate_waiting', startedAt: now, lastAttemptAt: now,
      brokerRequestId: 'certificate-request', privateKeyPem: privateKeySentinel, csrPem: csrSentinel,
    },
    termsVersion: null,
    certificateTransparencyAcceptedAt: now,
    certificate: { ...certificate, futurePrivateField: futureSecretSentinel },
    lastBrokerContactAt: now,
    lastHeartbeatAt: null,
    nextCheckAt: now,
    lastError: { code: 'certificate_pending', requestId: 'request-id', at: now, retryAfterSeconds: 30, futurePrivateField: futureSecretSentinel },
    futurePrivateField: futureSecretSentinel,
  } as FixtureState;
}

function fixture(options: {
  session?: { isAdmin: boolean } | null;
  state?: FixtureState | null;
  stateFailure?: boolean;
  readinessFailure?: boolean;
  termsFailure?: boolean;
  certificateDomains?: string[];
} = {}) {
  const state = options.state === undefined ? lifecycle() : options.state;
  const session = options.session === undefined ? { isAdmin: false } : options.session;
  const calls = { state: 0, certificate: 0, readiness: 0, terms: 0 };
  const api: { GET?: () => Promise<Response> } = {};
  runInNewContext(code, {
    exports: api,
    require(id: string) {
      if (id === 'next/server') return { NextResponse: { json: Response.json } };
      if (id === '@/lib/auth') return { getSession: async () => session };
      if (id === '@/lib/acme/storage') return { tlsStorage: { getCert: async () => {
        calls.certificate++;
        return { domains: options.certificateDomains ?? ['quiet-forest.example.test'], keyPem: privateKeySentinel };
      } } };
      if (id === '@/lib/youeye-names/client') return {
        getNamesReadiness: async () => {
          calls.readiness++;
          if (options.readinessFailure) throw new Error('provider unavailable');
          return readiness;
        },
        getCertificateTerms: async () => {
          calls.terms++;
          if (options.termsFailure) throw new Error('terms unavailable');
          return terms;
        },
      };
      if (id === '@/lib/youeye-names/maintenance') return {};
      if (id === '@/lib/youeye-names/state') return { readNamesLifecycleState: async () => {
        calls.state++;
        if (options.stateFailure) throw new Error(privateKeySentinel);
        return state;
      } };
      throw new Error(`Unexpected status dependency: ${id}`);
    },
  });
  return { get: () => api.GET!(), calls, state };
}

for (const isAdmin of [false, true]) {
  test(`Names status excludes provisioning credentials for ${isAdmin ? 'administrator' : 'ordinary'} sessions`, async () => {
    const f = fixture({ session: { isAdmin } });
    const protectedBefore = structuredClone(f.state);
    const response = await f.get();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const text = await response.text();
    for (const sentinel of [privateKeySentinel, csrSentinel, futureSecretSentinel]) {
      assert.equal(text.includes(sentinel), false, 'status must not serialize private lifecycle material');
    }
    const body = JSON.parse(text);
    assert.deepEqual(body, {
      active: true,
      state: {
        name: 'quiet-forest', fqdn: 'quiet-forest.example.test', status: 'provisioning',
        termsVersion: null, certificateTransparencyAcceptedAt: now, certificate,
        lastBrokerContactAt: now, lastHeartbeatAt: null, nextCheckAt: now,
        lastError: { code: 'certificate_pending', requestId: 'request-id', at: now, retryAfterSeconds: 30 },
      },
      certificateMatches: true, currentTerms: terms, serviceReachable: true, readiness,
    });
    assert.deepEqual(f.state, protectedBefore, 'status must preserve server-side resumption material');
  });
}

test('Names status rejects an absent session before reading protected state', async () => {
  const f = fixture({ session: null });
  const response = await f.get();
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'Unauthorized' });
  assert.deepEqual(f.calls, { state: 0, certificate: 0, readiness: 0, terms: 0 });
});

test('Names status retains inactive state and certificate mismatch behavior', async () => {
  const f = fixture({ state: null });
  const response = await f.get();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    active: false, state: null, certificateMatches: false,
    currentTerms: null, serviceReachable: true, readiness,
  });
  assert.equal(f.calls.terms, 0);
  const mismatch = await fixture({ certificateDomains: ['other.example.test'] }).get();
  assert.equal((await mismatch.json()).certificateMatches, false);
});

test('Names status preserves every lifecycle status and accepted terms without fetching new terms', async () => {
  for (const status of ['provisioning', 'healthy', 'renewing', 'attention', 'released'] as const) {
    const state = lifecycle();
    state.status = status;
    state.termsVersion = 'accepted-terms';
    const f = fixture({ state });
    const body = await (await f.get()).json();
    assert.equal(body.active, status !== 'released');
    assert.equal(body.state.status, status);
    assert.equal(body.state.termsVersion, 'accepted-terms');
    assert.equal(body.currentTerms, null);
    assert.equal(f.calls.terms, 0);
  }
});

test('Names status retains required terms refresh and nullable certificate/error fields', async () => {
  const state = lifecycle();
  state.termsVersion = 'accepted-terms';
  state.lastError!.code = 'certificate_terms_version_required';
  const f = fixture({ state });
  assert.deepEqual((await (await f.get()).json()).currentTerms, terms);
  assert.equal(f.calls.terms, 1);

  const absent = { ...lifecycle(), certificate: null, lastError: null };
  const body = await (await fixture({ state: absent }).get()).json();
  assert.equal(body.state.certificate, null);
  assert.equal(body.state.lastError, null);
});

test('Names status keeps provider failures separate from damaged local state', async () => {
  const degraded = fixture({ readinessFailure: true, termsFailure: true });
  const response = await degraded.get();
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.serviceReachable, false);
  assert.equal(body.readiness, null);
  assert.equal(body.currentTerms, null);

  const damaged = fixture({ stateFailure: true });
  const failure = await damaged.get();
  assert.equal(failure.status, 500);
  assert.deepEqual(await failure.json(), { error: 'YouEye Names lifecycle state is damaged or has unsafe permissions.' });
});
