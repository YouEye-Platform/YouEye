import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { exportByoDomainBundle } from '@/lib/byo-domain/bundle';

function bundleFilename(domain: string): string {
  const safe = domain.toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '');
  return `youeye-domain-${safe || 'domain'}.bundle.json`;
}

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session?.isAdmin) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  }

  const includeToken = request.nextUrl.searchParams.get('includeToken') === 'true';
  const bundle = await exportByoDomainBundle(includeToken);
  if (!bundle) {
    return NextResponse.json(
      { error: 'No provider-managed domain certificate to export.' },
      { status: 404 },
    );
  }

  return new NextResponse(JSON.stringify(bundle, null, 2), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'content-disposition': `attachment; filename="${bundleFilename(bundle.domain)}"`,
      'cache-control': 'no-store',
    },
  });
}
