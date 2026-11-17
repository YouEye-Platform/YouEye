/**
 * GET /api/setup/ca-fingerprint — `{ sha256: "AA:BB:…" }`: the SHA-256 fingerprint of the root certificate that
 * `/api/setup/ca-cert` serves, so the owner can compare it with the one on the box's screen before trusting it.
 * Public, and only on the setup surface (box IP or youeye.local).
 */

import { NextRequest, NextResponse } from 'next/server';
import { isLocalSetupHost } from '@/lib/auth/mode';
import { certificateFingerprint, readCaddyRootCertificate } from '@/lib/caddy/root-ca';

const noStore = { 'Cache-Control': 'no-store' };

export async function GET(request: NextRequest) {
  if (!isLocalSetupHost(request.headers.get('host') || '')) {
    return NextResponse.json({ error: 'Not found' }, { status: 404, headers: noStore });
  }
  try {
    const certificate = await readCaddyRootCertificate();
    if (!certificate) return NextResponse.json({ error: 'CA certificate not available' }, { status: 404, headers: noStore });
    return NextResponse.json({ sha256: certificateFingerprint(certificate) }, { headers: noStore });
  } catch {
    return NextResponse.json({ error: 'Failed to read the CA certificate' }, { status: 500, headers: noStore });
  }
}
