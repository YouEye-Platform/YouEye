import { NextRequest, NextResponse } from 'next/server';
import { getSession, verifyCSRFToken } from '@/lib/auth';
import {
  namesErrorMessage,
  getCurrentCertificate,
  releaseName,
  revokeCertificate,
} from '@/lib/youeye-names/client';
import {
  readNamesLifecycleState,
  updateNamesLifecycleState,
} from '@/lib/youeye-names/state';
import { settingsService } from '@/lib/settings';

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session?.isAdmin) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  }
  const csrfToken = request.headers.get('X-CSRF-Token');
  if (!csrfToken || !(await verifyCSRFToken(csrfToken))) {
    return NextResponse.json({ error: 'Invalid CSRF token' }, { status: 403 });
  }
  const state = await readNamesLifecycleState();
  if (!state || state.status === 'released') {
    return NextResponse.json({ error: 'YouEye Names is not active.' }, { status: 409 });
  }
  const settings = await settingsService.getRaw();
  if (settings.domain === state.fqdn) {
    return NextResponse.json(
      { error: 'Change the server URL away from this YouEye Name before releasing it.' },
      { status: 409 },
    );
  }
  const body = (await request.json().catch(() => ({}))) as {
    confirmation?: unknown;
  };
  if (body.confirmation !== state.fqdn) {
    return NextResponse.json(
      { error: `Type ${state.fqdn} exactly to release this name.` },
      { status: 400 },
    );
  }
  try {
    const brokerCertificate = await getCurrentCertificate(state.name);
    if (brokerCertificate) {
      await revokeCertificate(
        state.name,
        brokerCertificate.fingerprint,
        'cessation_of_operation',
      );
    }
    await releaseName(state.name);
    await updateNamesLifecycleState((current) => ({
      ...current,
      status: 'released',
      nextCheckAt: null,
      lastBrokerContactAt: new Date().toISOString(),
      lastError: null,
    }));
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: namesErrorMessage(error) }, { status: 503 });
  }
}
