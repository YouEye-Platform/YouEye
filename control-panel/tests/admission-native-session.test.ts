import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { timingSafeEqual } from 'node:crypto';

test('native session validation keeps a revoked session denied after access is restored', async () => {
  let allowed = true;
  let revokedBefore = 100;
  const checks: number[] = [];
  const code = ts.transpileModule(readFileSync(
    new URL('../src/app/identity/session/check/route.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: { GET?: (request: Request) => Promise<Response> } = {};
  vm.runInNewContext(code, {
    exports, Buffer, Date, Number,
    require: (name: string) => {
      if (name === 'next/server') return { NextResponse: Response };
      if (name === 'crypto') return { timingSafeEqual };
      if (name === '@/lib/identity/http') return {
        getIdentitySession: async () => ({ id: 'subject' }),
        getIdentitySessionId: async () => 'session',
      };
      if (name === '@/lib/identity/store') return {
        getClient: async (id: string) => id === 'app-a' ? { client_secret: 'fixture-secret' } : null,
        getIdentitySessionById: async (id: string) => id === 'session' ? { user_id: 'subject' } : null,
      };
      if (name === '@/lib/admission/store') return {
        evaluateClientAdmission: async () => ({ allowed }),
        clientTokenRevoked: async (_client: string, _user: string, issuedAt: number) => {
          checks.push(issuedAt);
          return issuedAt <= revokedBefore;
        },
      };
      throw new Error(`Unexpected dependency ${name}`);
    },
  });
  const request = (issuedAt?: string, extra: Record<string, string> = {}) => new Request('http://identity/session/check', {
    headers: {
      'x-youeye-client-id': 'app-a', 'x-youeye-client-secret': 'fixture-secret',
      'x-youeye-expected-sub': 'subject', 'x-youeye-expected-sid': 'session',
      ...(issuedAt === undefined ? {} : { 'x-youeye-session-issued-at': issuedAt }), ...extra,
    },
  });
  const status = async (value?: string, extra?: Record<string, string>) => (await exports.GET!(request(value, extra))).status;
  assert.equal(await status('101'), 204);
  allowed = false;
  revokedBefore = 200;
  assert.equal(await status('101'), 401);
  allowed = true;
  assert.equal(await status('101'), 401, 'a new grant must not revive a cached native session');
  assert.equal(await status('200'), 401, 'the revocation boundary is inclusive');
  assert.equal(await status('201'), 204, 'a later authorization can establish a fresh session');
  for (const invalid of [undefined, '', '0', '-1', 'NaN', '100.5', '1e3', '999999999999']) {
    const count = checks.length;
    assert.equal(await status(invalid), 401);
    assert.equal(checks.length, count, 'invalid timestamps never reach a cutoff query');
  }
  assert.equal(await status('201', { 'x-youeye-client-secret': 'forged' }), 401);
  assert.equal(await status('201', { 'x-youeye-client-id': 'unknown' }), 401);
  assert.equal(await status('201', { 'x-youeye-expected-sub': 'another-user' }), 401);
  assert.equal((await exports.GET!(new Request('http://identity/session/check'))).status, 204,
    'browser identity checks retain their separate cookie contract');
});
