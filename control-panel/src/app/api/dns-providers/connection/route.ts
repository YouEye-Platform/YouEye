import { NextRequest, NextResponse } from 'next/server';
import { getSession, verifyCSRFToken } from '@/lib/auth';
import { clearByoDnsProviderConfig, getByoDnsProviderConfig } from '@/lib/dns-providers/config';
import { deleteProviderToken } from '@/lib/dns-providers/secrets';

export async function DELETE(request: NextRequest) {
  const session = await getSession();
  if (!session?.isAdmin) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  }

  const csrfToken = request.headers.get('X-CSRF-Token');
  if (!csrfToken || !(await verifyCSRFToken(csrfToken))) {
    return NextResponse.json({ error: 'Invalid CSRF token' }, { status: 403 });
  }

  const config = await getByoDnsProviderConfig();
  if (config) {
    await deleteProviderToken(config.connectionId);
    await clearByoDnsProviderConfig();
  }

  return NextResponse.json({
    ok: true,
    message: 'DNS provider disconnected. Existing DNS records were left in place.',
  });
}
