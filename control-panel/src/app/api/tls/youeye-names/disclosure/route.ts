import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import {
  getCertificateTerms,
  getPrivacyNotice,
  namesErrorMessage,
} from '@/lib/youeye-names/client';
import { discoverNamesService } from '@/lib/youeye-names/service';

/** Keep browser setup code off the broker origin while showing current terms. */
export async function GET() {
  const session = await getSession();
  if (!session?.isAdmin) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  }
  try {
    const [terms, privacy, service] = await Promise.all([
      getCertificateTerms(),
      getPrivacyNotice(),
      discoverNamesService(),
    ]);
    return NextResponse.json(
      { terms, privacy, service },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: namesErrorMessage(error) },
      { status: 503, headers: { 'cache-control': 'no-store' } },
    );
  }
}
