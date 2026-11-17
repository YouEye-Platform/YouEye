/**
 * POST /api/setup/names/start — start the YouEye Names job right after the
 * human check: terms, discovery, registration, claim, key + CSR and the
 * certificate request. Returns at once; the certificate is awaited in the
 * background and installed when it arrives (lifecycle.json records each stage).
 */
import { NextRequest, NextResponse } from 'next/server';
import { withSetupRequestWork } from '@/lib/setup/readiness';
import { requireSetupSession } from '@/lib/setup/session';
import { namesErrorMessage, namesLogReason } from '@/lib/youeye-names/client';
import { followClaimedNamesJob, followNamesJob, NamesJobError, startNamesJob } from '@/lib/youeye-names/provision';

const noStore = { 'cache-control': 'no-store' };

export async function POST(request: NextRequest) {
  const auth = await requireSetupSession(request);
  if (auth.response) return auth.response;
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  try {
    const status = await withSetupRequestWork(auth.session.authMethod, () => startNamesJob({
      name: typeof body.name === 'string' ? body.name : '',
      fqdn: typeof body.fqdn === 'string' ? body.fqdn : '',
      termsVersion: body.termsVersion,
      ctAccepted: body.ctAccepted,
      humanVerificationProof: body.humanVerificationProof,
      verifiedSetupSession: body.verifiedSetupSession,
    }));
    // Outside the request's lifecycle work: the wait outlives this response.
    void followNamesJob().catch((error) => {
      console.error('[setup/names] certificate job failed:', namesLogReason(error));
    });
    return NextResponse.json(status, { headers: noStore });
  } catch (error) {
    console.error('[setup/names] start failed:', namesLogReason(error));
    // A claimed name whose certificate request failed: the background wait/retry starts at once.
    void followClaimedNamesJob().catch((followError) => {
      console.error('[setup/names] certificate job failed:', namesLogReason(followError));
    });
    if (error instanceof NamesJobError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status, headers: noStore });
    }
    return NextResponse.json({ error: namesErrorMessage(error) }, { status: 502, headers: noStore });
  }
}
