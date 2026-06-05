import { NextRequest, NextResponse } from 'next/server';
import { getIdentityConfig } from '@/lib/identity/config';
import { SESSION_COOKIE } from '@/lib/identity/tokens';

export async function GET(request: NextRequest) {
  const config = await getIdentityConfig();
  const redirectTo = request.nextUrl.searchParams.get('post_logout_redirect_uri') || config.externalUrl;
  const response = NextResponse.redirect(redirectTo);
  response.cookies.delete(SESSION_COOKIE);
  return response;
}

