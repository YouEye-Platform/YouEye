import { NextRequest, NextResponse } from 'next/server';
import { getIdentityConfig } from '@/lib/identity/config';
import { getIdentitySession, userinfo } from '@/lib/identity/http';
import { resolveAdmissionRoute, evaluateAppAdmission } from '@/lib/admission/store';
import { ensureIdentitySchema, identityRows, identitySql } from '@/lib/identity/store';
import { admissionReconciliationState } from '@/lib/admission/projection';

function originalUrl(request: NextRequest): string {
  const proto = request.headers.get('x-forwarded-proto') || 'https';
  const host = request.headers.get('x-forwarded-host') || request.headers.get('host') || '';
  const uri = request.headers.get('x-forwarded-uri') || '/';
  return `${proto}://${host}${uri}`;
}

export async function GET(request: NextRequest) {
  const host = (request.headers.get('x-forwarded-host') || '').toLowerCase();
  const uri = request.headers.get('x-forwarded-uri') || '';
  let path: string;
  try {
    if (!uri.startsWith('/') || uri.startsWith('//')) throw new Error('Invalid route');
    path = new URL(uri, 'https://admission.invalid').pathname;
  } catch {
    return NextResponse.json({ error: 'unknown_app_route' }, { status: 403 });
  }
  const policy = await resolveAdmissionRoute(host, path);
  if (!policy) return NextResponse.json({ error: 'unknown_app_route' }, { status: 403 });
  // Exact native signed-logout transport authenticates itself; no identity
  // headers or browser admission are supplied for machine callbacks.
  await ensureIdentitySchema();
  const callback = await identityRows(`SELECT path FROM admission_machine_callbacks
    WHERE installation_id = ${identitySql(policy.installationId)}::uuid
      AND host = ${identitySql(host)} AND path = ${identitySql(path)}
      AND method = ${identitySql(request.headers.get('x-forwarded-method') || 'GET')}`);
  if (callback.length && policy.state === 'ready') return new NextResponse(null, { status: 204 });
  if (policy.publicAccess && policy.state === 'ready' && await admissionReconciliationState(policy.appId) === 'applied') {
    return new NextResponse(null, { status: 204 });
  }
  const config = await getIdentityConfig();
  const user = await getIdentitySession(request);
  if (!user) {
    const login = new URL('/identity/login', config.externalUrl);
    login.searchParams.set('return_to', originalUrl(request));
    return NextResponse.redirect(login);
  }
  const admission = await evaluateAppAdmission(policy.appId, user.id);
  if (!admission.allowed) {
    return NextResponse.json({ error: admission.reason === 'policy_pending' ? 'app_policy_pending' : 'app_access_denied' },
      { status: admission.reason === 'policy_pending' ? 503 : 403, headers: { 'Cache-Control': 'no-store' } });
  }

  const info = userinfo(user);
  const response = new NextResponse(null, { status: 204 });
  response.headers.set('X-YouEye-Username', info.preferred_username);
  response.headers.set('X-YouEye-Groups', info.groups.join(','));
  response.headers.set('X-YouEye-Email', info.email);
  response.headers.set('X-YouEye-Name', info.name);
  response.headers.set('X-YouEye-Uid', info.sub);
  return response;
}
