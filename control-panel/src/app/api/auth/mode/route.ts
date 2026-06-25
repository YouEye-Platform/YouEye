/**
 * Auth Mode API
 *
 * GET /api/auth/mode - Returns the auth mode for the current request context
 *
 * - IP access (e.g., 192.168.1.100:3000) → PAM login
 * - Subdomain access (e.g., control.youeye.local) → SSO redirect
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthModeForHost } from '@/lib/auth/mode';
import { isSSOConfigured } from '@/lib/auth/authentik';

export async function GET(request: NextRequest) {
  const host = request.headers.get('host') || '';
  const ssoConfigured = isSSOConfigured();
  const mode = getAuthModeForHost(host);

  return NextResponse.json({ mode, host, ssoConfigured });
}
