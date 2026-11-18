/**
 * GET /api/tls/youeye-names/reuse
 *
 * What the setup address step should offer instead of new names:
 * - `reuse`: a YouEye Names bundle staged by the installer (`--names-bundle`);
 *   the address is locked to it.
 * - `lease`: a name this server already claimed during setup (the Names job
 *   is running or finished, setup is not complete). The owner continues with
 *   it (no new human check) or releases it to choose another.
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { settingsService } from '@/lib/settings';
import { getStagedBundle } from '@/lib/youeye-names/bundle';
import { namesJobStatusOf } from '@/lib/youeye-names/provision';
import { readNamesLifecycleState } from '@/lib/youeye-names/state';

export async function GET() {
  const session = await getSession();
  if (!session?.isAdmin) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  }
  let lease = null;
  try {
    const [state, settings] = await Promise.all([readNamesLifecycleState(), settingsService.getRaw()]);
    const status = namesJobStatusOf(state);
    if (settings.setup_completed !== true && status.stage !== 'none') lease = status;
  } catch {
    return NextResponse.json(
      {
        reuse: false,
        name: null,
        fqdn: null,
        lease: null,
        error: 'The YouEye Names state on this server is damaged or has unsafe permissions.',
      },
      { status: 422, headers: { 'cache-control': 'no-store' } },
    );
  }
  try {
    const bundle = await getStagedBundle();
    return NextResponse.json({
      reuse: !!bundle,
      name: bundle?.name ?? null,
      fqdn: bundle?.fqdn ?? null,
      lease,
    }, { headers: { 'cache-control': 'no-store' } });
  } catch {
    return NextResponse.json(
      {
        reuse: false,
        name: null,
        fqdn: null,
        lease,
        error: 'The saved YouEye Names bundle is damaged or has unsafe permissions. Replace or remove it before continuing.',
      },
      { status: 422, headers: { 'cache-control': 'no-store' } },
    );
  }
}
