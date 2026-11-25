/**
 * Rate Limit Management API
 *
 * DELETE /api/auth/rate-limit — Reset all rate limits (admin only)
 *
 * Allows admins to clear the in-memory rate limit store, unblocking
 * users who have been locked out due to too many failed login attempts.
 */

import { NextResponse } from 'next/server';
import { getSession, verifyCSRFToken, resetAllRateLimits } from '@/lib/auth';
import { resetSignInLimits } from '@/lib/identity/sign-in-limit';

export async function DELETE(request: Request) {
  const session = await getSession();
  if (!session?.isAdmin) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const csrfToken = request.headers.get('X-CSRF-Token');
  if (!csrfToken || !(await verifyCSRFToken(csrfToken))) {
    return NextResponse.json({ error: 'Invalid CSRF token' }, { status: 403 });
  }

  // This process's limits: the sign-in limits (YE-149) live beside the other attempt limits.
  const cleared = resetAllRateLimits() + resetSignInLimits();

  // YouEye ID's sign-in limits live in its own process (port 3001) and are not cleared here.
  console.log(`[rate-limit] Admin "${session.username}" reset this Control Panel process's attempt limits (${cleared} entries cleared)`);

  return NextResponse.json({
    success: true,
    cleared,
  });
}
