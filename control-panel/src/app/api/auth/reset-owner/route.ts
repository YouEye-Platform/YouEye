/**
 * POST /api/auth/reset-owner (public; the page posts to /settings/api/auth/reset-owner)
 *
 * The owner forgot their password: Recovery's "Reset owner password" makes the
 * box's console show a one-time code. See lib/console-access/owner-reset.
 */
import { NextRequest, NextResponse } from 'next/server';
import { checkRateLimit } from '@/lib/auth';
import { requestClientAddress } from '@/lib/auth/client-address';
import { isLocalSetupHost } from '@/lib/auth/mode';
import { resetOwnerPassword } from '@/lib/console-access/owner-reset';
import { setPassword } from '@/lib/identity/provider';
import { getApplianceOwnerId, revokeAllIdentitySessions } from '@/lib/identity/store';
import { spineClient } from '@/lib/spine/client';

export const dynamic = 'force-dynamic';

// Attempts per client address and window: the TCP peer, Caddy's X-Forwarded-For only from Caddy (YE-136). Loopback
// and unknown are no client address and get no limit here, so nobody can lock the owner out; the per-code limit is
// Spine's (10 wrong codes pause the code for 15 minutes, `consoleaccess/reset.go`).
const MAX_ATTEMPTS = 10;
const WINDOW_SECONDS = 15 * 60;

/** A browser form on this host; refuses cross-site posts. */
function sameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get('origin');
  const host = request.headers.get('x-forwarded-host') || request.headers.get('host') || '';
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export async function POST(request: NextRequest) {
  // Only on the box's own network address or youeye.local (like the claim): nobody on the
  // internet side of a name or tunnel can try codes, or slow the owner down.
  if (!isLocalSetupHost(request.headers.get('host') || '') || !sameOrigin(request)) {
    return NextResponse.json({ error: 'The password could not be reset. Try again.', code: 'unavailable' }, { status: 403 });
  }
  const address = await requestClientAddress(request.headers);
  const limit = address ? checkRateLimit(`owner-reset:${address}`, MAX_ATTEMPTS, WINDOW_SECONDS) : null;
  if (limit && !limit.allowed) {
    return NextResponse.json(
      { error: 'Too many attempts. Try again in a few minutes.', code: 'rate_limited' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil((limit.resetAt - Date.now()) / 1000)) } },
    );
  }
  const result = await resetOwnerPassword(await request.json().catch(() => null), {
    ownerId: getApplianceOwnerId,
    useCode: code => spineClient.useOwnerResetCode(code),
    setPassword,
    revokeSessions: revokeAllIdentitySessions,
    log: message => console.log(message),
  });
  if (result.status === 200) return NextResponse.json({ success: true });
  return NextResponse.json({ error: result.error, code: result.code }, { status: result.status });
}
