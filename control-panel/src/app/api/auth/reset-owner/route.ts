/**
 * POST /api/auth/reset-owner (public; the page posts to /settings/api/auth/reset-owner)
 *
 * The owner forgot their password: Recovery's "Reset owner password" makes the
 * box's console show a one-time code. See lib/console-access/owner-reset.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requestClientAddress } from '@/lib/auth/client-address';
import { isLocalSetupHost } from '@/lib/auth/mode';
import { beginSignInAttempt, signInNotCounted, signInRetryAfterSeconds, signInSucceeded } from '@/lib/identity/sign-in-limit';
import { resetOwnerPassword } from '@/lib/console-access/owner-reset';
import { setPassword } from '@/lib/identity/provider';
import { getApplianceOwnerId, revokeAllIdentitySessions } from '@/lib/identity/store';
import { spineClient } from '@/lib/spine/client';

export const dynamic = 'force-dynamic';

// Wrong codes are sign-in failures for the owner (`sign-in-limit.ts`, scope `owner-reset`): 10 per client address in
// 15 minutes lock that address, and every source is slowed down, also loopback and unknown peers, which are never
// locked. The client address is the TCP peer, Caddy's X-Forwarded-For only from Caddy (YE-136). The per-code limit is
// Spine's (10 wrong codes pause the code for 15 minutes, `consoleaccess/reset.go`; YE-159).
const OWNER = 'owner';

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
  const attempt = beginSignInAttempt(OWNER, await requestClientAddress(request.headers), 'owner-reset');
  if (!attempt.allowed) {
    const retryAfter = signInRetryAfterSeconds(attempt);
    return NextResponse.json(
      {
        error: attempt.refusal === 'wait'
          ? `Too many attempts. Try again in ${retryAfter} seconds.`
          : 'Too many attempts. Try again in a few minutes.',
        code: 'rate_limited',
      },
      { status: 429, headers: { 'Retry-After': String(retryAfter) } },
    );
  }
  const result = await resetOwnerPassword(await request.json().catch(() => null), {
    ownerId: getApplianceOwnerId,
    useCode: code => spineClient.useOwnerResetCode(code),
    setPassword,
    revokeSessions: revokeAllIdentitySessions,
    log: message => console.log(message),
  });
  if (result.status === 200) {
    signInSucceeded(attempt);
    return NextResponse.json({ success: true });
  }
  // Only a wrong code is a guess; a password the form refuses, a mismatch or Spine being unavailable count nothing.
  if (result.code !== 'invalid_code') signInNotCounted(attempt);
  return NextResponse.json({ error: result.error, code: result.code }, { status: result.status });
}
