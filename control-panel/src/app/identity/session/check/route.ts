import { NextRequest, NextResponse } from 'next/server';
import { getIdentitySession } from '@/lib/identity/http';
import { getIdentitySessionId } from '@/lib/identity/http';
import { getClient, getIdentitySessionById } from '@/lib/identity/store';
import { timingSafeEqual } from 'crypto';
import { clientTokenRevoked, evaluateClientAdmission } from '@/lib/admission/store';

export async function GET(request: NextRequest) {
  const expectedSubject = request.headers.get('x-youeye-expected-sub');
  const expectedSession = request.headers.get('x-youeye-expected-sid');
  const clientId = request.headers.get('x-youeye-client-id');
  const clientSecret = request.headers.get('x-youeye-client-secret');
  const issuedAtText = request.headers.get('x-youeye-session-issued-at') || '';
  const issuedAt = /^\d{1,12}$/.test(issuedAtText) ? Number(issuedAtText) : NaN;
  const validIssueTime = Number.isSafeInteger(issuedAt) && issuedAt > 0
    && issuedAt <= Math.floor(Date.now() / 1000) + 30;
  if (clientId || clientSecret) {
    const client = clientId ? await getClient(clientId) : null;
    const expected = Buffer.from(client?.client_secret || '', 'utf8');
    const supplied = Buffer.from(clientSecret || '', 'utf8');
    const authorized = Boolean(client?.client_secret && expected.length === supplied.length && timingSafeEqual(expected, supplied));
    const session = authorized && validIssueTime && expectedSubject && expectedSession
      ? await getIdentitySessionById(expectedSession, true) : null;
    const active = Boolean(session && session.user_id === expectedSubject && clientId
      && (await evaluateClientAdmission(clientId, session.user_id)).allowed
      && !await clientTokenRevoked(clientId, session.user_id, issuedAt));
    return new NextResponse(null, { status: active ? 204 : 401, headers: { 'Cache-Control': 'no-store' } });
  }
  const user = await getIdentitySession(request);
  const sessionId = expectedSession ? await getIdentitySessionId(request) : null;
  return new NextResponse(null, {
    status: user && (!expectedSubject || user.id === expectedSubject)
      && (!expectedSession || sessionId === expectedSession) ? 204 : 401,
    headers: { 'Cache-Control': 'no-store' },
  });
}
