/**
 * GET /api/tls/youeye-names/export
 *
 * Downloads the YouEye Names reuse bundle (install identity + TLS key + cert +
 * lease name) so it can be re-imported on a (re)install via the installer's
 * --names-bundle flag — reusing the address + certificate with no new Let's
 * Encrypt issuance.
 *
 * The bundle contains PRIVATE KEYS — it is a credential. Admin only; no-store.
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { exportBundle } from '@/lib/youeye-names/bundle';

export async function GET() {
  const session = await getSession();
  if (!session?.isAdmin) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  }
  const bundle = await exportBundle();
  if (!bundle) {
    return NextResponse.json(
      { error: 'No YouEye Names certificate to export (this server is not using a *.youeye.me address).' },
      { status: 404 },
    );
  }
  return new NextResponse(JSON.stringify(bundle, null, 2), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'content-disposition': `attachment; filename="youeye-names-${bundle.name}.bundle.json"`,
      'cache-control': 'no-store',
    },
  });
}
