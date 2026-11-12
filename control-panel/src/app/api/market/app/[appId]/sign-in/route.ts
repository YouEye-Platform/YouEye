/**
 * GET /api/market/app/{appId}/sign-in → { appId, available, enabled }
 * PUT /api/market/app/{appId}/sign-in  { enabled: boolean }
 *
 * Turn YouEye ID sign-in on or off for an installed app whose SSO needs a setup file: on runs
 * `setup/sso.yaml`, off runs its `remove:` steps and removes the app's OAuth client.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth/rbac';
import { verifyCSRFToken } from '@/lib/auth/session';
import { getAppSignIn, setAppSignIn, SignInRefusal } from '@/lib/market/sign-in';
import { withUserOperationLockWait } from '@/lib/market/update-admission';
import { logOperationFailure } from '@/lib/market/install-tracker';
import { SetupStepError } from '@/lib/market/setup-runner';

export const dynamic = 'force-dynamic';

const Body = z.object({ enabled: z.boolean() }).strict();
const APP_ID = /^[a-z][a-z0-9-]{0,31}$/;

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ appId: string }> },
) {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;
  const { appId } = await params;
  if (!APP_ID.test(appId)) return NextResponse.json({ error: 'Invalid app id' }, { status: 400 });
  try {
    return NextResponse.json(await getAppSignIn(appId));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof SignInRefusal ? error.message : 'Sign-in setting is unavailable' },
      { status: 404 },
    );
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ appId: string }> },
) {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;
  const csrf = request.headers.get('X-CSRF-Token');
  if (!csrf || !(await verifyCSRFToken(csrf))) {
    return NextResponse.json({ error: 'Invalid CSRF token' }, { status: 403 });
  }
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Expected { enabled: boolean }' }, { status: 400 });
  const { appId } = await params;
  if (!APP_ID.test(appId)) return NextResponse.json({ error: 'Invalid app id' }, { status: 400 });
  try {
    return NextResponse.json(await withUserOperationLockWait(() => setAppSignIn(appId, parsed.data.enabled)));
  } catch (error) {
    logOperationFailure(`Changing YouEye ID sign-in of ${appId}`, error);
    // Setup failures carry app output; only the failing step is named.
    const message = error instanceof SignInRefusal ? error.message
      : error instanceof SetupStepError ? `${error.file} step ${error.step} (${error.kind}) failed; see the CP log`
        : 'The sign-in setting could not be changed; see the CP log';
    return NextResponse.json({ error: message }, { status: 409 });
  }
}
