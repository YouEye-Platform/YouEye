import { NextRequest, NextResponse } from 'next/server';
import { getSession, verifyCSRFToken } from '@/lib/auth';
import { validateDnsProvider } from '@/lib/dns-providers/validation';

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session?.isAdmin) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  }

  const csrfToken = request.headers.get('X-CSRF-Token');
  if (!csrfToken || !(await verifyCSRFToken(csrfToken))) {
    return NextResponse.json({ error: 'Invalid CSRF token' }, { status: 403 });
  }

  try {
    const body = await request.json();
    const domain = typeof body.domain === 'string' ? body.domain : '';
    const token = typeof body.token === 'string' ? body.token : '';
    if (!token.trim()) {
      return NextResponse.json({ error: 'Token is required' }, { status: 400 });
    }

    const result = await validateDnsProvider({
      provider: 'cloudflare',
      domain,
      token,
      writeTest: body.writeTest !== false,
    });

    return NextResponse.json(result, { status: result.ok ? 200 : 400 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Provider validation failed' },
      { status: 500 },
    );
  }
}
