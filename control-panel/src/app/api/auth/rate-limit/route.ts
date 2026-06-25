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

export async function DELETE(request: Request) {
  const session = await getSession();
  if (!session?.isAdmin) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const csrfToken = request.headers.get('X-CSRF-Token');
  if (!csrfToken || !(await verifyCSRFToken(csrfToken))) {
    return NextResponse.json({ error: 'Invalid CSRF token' }, { status: 403 });
  }

  const cleared = resetAllRateLimits();

  console.log(`[rate-limit] Admin "${session.username}" reset all rate limits (${cleared} entries cleared)`);

  return NextResponse.json({
    success: true,
    cleared,
  });
}
