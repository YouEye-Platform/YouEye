/**
 * Auth Mode API
 *
 * GET /api/auth/mode - Returns the auth mode for the current request context
 *
 * - IP access (e.g., 192.168.1.100:3000) → PAM login
 * - Subdomain access (e.g., control.youeye.local) → SSO redirect
 */

import { NextRequest, NextResponse } from 'next/server';
import { isSSOConfigured } from '@/lib/auth/authentik';

/** Check if the Host header looks like a raw IP (possibly with port) */
function isIPAccess(host: string): boolean {
  const hostname = host.split(':')[0];
  // IPv4 pattern
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;
  // localhost
  if (hostname === 'localhost' || hostname === '127.0.0.1') return true;
  return false;
}

export async function GET(request: NextRequest) {
  const host = request.headers.get('host') || '';
  const ipAccess = isIPAccess(host);
  const ssoConfigured = isSSOConfigured();

  // IP access always gets PAM; subdomain gets SSO if configured, else PAM fallback
  const mode = ipAccess || !ssoConfigured ? 'pam' : 'sso';

  return NextResponse.json({ mode, host, ssoConfigured });
}
