import { NextRequest, NextResponse } from 'next/server';
import { getIdentityConfig } from '@/lib/identity/config';
import { userinfo } from '@/lib/identity/http';
import { SESSION_COOKIE, verifyIdentityToken } from '@/lib/identity/tokens';
import { evaluateAppAdmission, listAdmissionHostRoutes } from '@/lib/admission/store';
import { identityRows, identitySql } from '@/lib/identity/store';
import { admissionReconciliationState } from '@/lib/admission/projection';
import { checkForwardAuth, type ForwardAuthDeps } from '@/lib/identity/forward-auth';

function originalUrl(request: NextRequest): string {
  const proto = request.headers.get('x-forwarded-proto') || 'https';
  const host = request.headers.get('x-forwarded-host') || request.headers.get('host') || '';
  const uri = request.headers.get('x-forwarded-uri') || '/';
  return `${proto}://${host}${uri}`;
}

const deps: ForwardAuthDeps = {
  hostRoutes: listAdmissionHostRoutes,
  machineCallbacks: (installationId, host) => identityRows<{ method: string; path: string }>(
    `SELECT method, path FROM admission_machine_callbacks
      WHERE installation_id = ${identitySql(installationId)}::uuid AND host = ${identitySql(host)}`),
  publicAccessApplied: async appId => await admissionReconciliationState(appId) === 'applied',
  identify: async token => {
    const user = await verifyIdentityToken(token);
    if (!user) return null;
    const info = userinfo(user);
    return {
      userId: user.id,
      headers: {
        'X-YouEye-Username': info.preferred_username,
        'X-YouEye-Groups': info.groups.join(','),
        'X-YouEye-Email': info.email,
        'X-YouEye-Name': info.name,
        'X-YouEye-Uid': info.sub,
      },
    };
  },
  evaluate: evaluateAppAdmission,
};

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
  const result = await checkForwardAuth({
    host, path,
    method: request.headers.get('x-forwarded-method') || 'GET',
    sessionToken: request.cookies.get(SESSION_COOKIE)?.value,
  }, deps);

  switch (result.kind) {
    case 'unknown_route':
      return NextResponse.json({ error: 'unknown_app_route' }, { status: 403 });
    case 'pass':
      return new NextResponse(null, { status: 204 });
    case 'login': {
      const config = await getIdentityConfig();
      const login = new URL('/identity/login', config.externalUrl);
      login.searchParams.set('return_to', originalUrl(request));
      return NextResponse.redirect(login);
    }
    case 'deny':
      return NextResponse.json({ error: result.pending ? 'app_policy_pending' : 'app_access_denied' },
        { status: result.pending ? 503 : 403, headers: { 'Cache-Control': 'no-store' } });
    case 'allow': {
      const response = new NextResponse(null, { status: 204 });
      for (const [name, value] of Object.entries(result.headers)) response.headers.set(name, value);
      return response;
    }
  }
}
