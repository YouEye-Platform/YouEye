import { NextRequest, NextResponse } from 'next/server';
import { getSession, verifyCSRFToken } from '@/lib/auth';
import { tlsStorage } from '@/lib/acme/storage';
import { getCertificateTerms, getNamesReadiness, namesErrorMessage } from '@/lib/youeye-names/client';
import { runNamesMaintenance } from '@/lib/youeye-names/maintenance';
import {
  readNamesLifecycleState,
  updateNamesLifecycleState,
} from '@/lib/youeye-names/state';

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    const state = await readNamesLifecycleState();
    const certificate = await tlsStorage.getCert();
    const readiness = await getNamesReadiness().catch(() => null);
    let currentTerms = null;
    if (
      state &&
      state.status !== 'released' &&
      (!state.termsVersion || state.lastError?.code === 'certificate_terms_version_required')
    ) {
      currentTerms = await getCertificateTerms().catch(() => null);
    }
    return NextResponse.json(
      {
        active: !!state && state.status !== 'released',
        state,
        certificateMatches:
          !!state && !!certificate && certificate.domains.includes(state.fqdn),
        currentTerms,
        serviceReachable: readiness !== null,
        readiness,
      },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch {
    return NextResponse.json(
      { error: 'YouEye Names lifecycle state is damaged or has unsafe permissions.' },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session?.isAdmin) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  }
  const csrfToken = request.headers.get('X-CSRF-Token');
  if (!csrfToken || !(await verifyCSRFToken(csrfToken))) {
    return NextResponse.json({ error: 'Invalid CSRF token' }, { status: 403 });
  }
  const body = (await request.json().catch(() => ({}))) as { action?: unknown };
  try {
    if (body.action === 'accept-current-terms') {
      const terms = await getCertificateTerms();
      const acceptedAt = new Date().toISOString();
      const updated = await updateNamesLifecycleState((state) => ({
        ...state,
        termsVersion: terms.version,
        certificateTransparencyAcceptedAt: acceptedAt,
        status: state.status === 'attention' ? 'healthy' : state.status,
        lastError:
          state.lastError?.code === 'certificate_terms_version_required'
            ? null
            : state.lastError,
      }));
      if (!updated) {
        return NextResponse.json({ error: 'YouEye Names is not active.' }, { status: 409 });
      }
      return NextResponse.json({ ok: true, termsVersion: terms.version });
    }
    if (body.action === 'check-now') {
      await runNamesMaintenance();
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: 'Unsupported action' }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: namesErrorMessage(error) }, { status: 503 });
  }
}
