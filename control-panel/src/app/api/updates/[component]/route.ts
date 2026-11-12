import { NextRequest, NextResponse } from 'next/server';
import { SpineAPIError, spineClient, type SpineRuntimeCapabilities } from '@/lib/spine/client';
import { getSession, verifyCSRFToken } from '@/lib/auth/session';
import { startUpdate, writeStatus, completeUpdate, failUpdate } from '@/lib/updates/state';
import { assertNoCriticalIssues } from '@/lib/health/issues';

// POST /api/updates/[component] - Trigger update for a component.
// Spine, the Control Panel and the UI update only with the System release
// (/api/appliance/core-update/*); this route covers Incus, host packages and
// Spine-managed infrastructure apps.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ component: string }> }
) {
  // Authentication check
  const session = await getSession();
  if (!session) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401 }
    );
  }

  // CSRF token verification. verifyCSRFToken handles the missing-header case
  // itself, including the CLI-token bypass — a `!csrfToken` pre-check here
  // would 403 `spine update ui` before the bypass can run.
  const csrfToken = request.headers.get('X-CSRF-Token');
  if (!(await verifyCSRFToken(csrfToken ?? ''))) {
    return NextResponse.json(
      { error: 'Invalid CSRF token' },
      { status: 403 }
    );
  }

  // Admin check - only admins can trigger updates
  if (!session.isAdmin) {
    return NextResponse.json(
      { error: 'Admin access required' },
      { status: 403 }
    );
  }

  const { component } = await params;

  if (['spine', 'control', 'ui'].includes(component)) {
    return NextResponse.json(
      { error: `${component} updates with the System release`, code: 'system_release' },
      { status: 409 },
    );
  }

  const capabilityForComponent: Partial<Record<string, keyof SpineRuntimeCapabilities>> = {
    incus: 'incus_update',
    system: 'system_update',
  };
  const requiredCapability = capabilityForComponent[component] ?? 'app_update';
  try {
    const runtime = (await spineClient.status()).runtime;
    if (runtime && runtime.capabilities[requiredCapability] === false) {
      return NextResponse.json(
        {
          code: 'capability_not_supported',
          action: requiredCapability.replaceAll('_', '-'),
          runtime: runtime.kind,
          message: `${component} is managed by the system image on this appliance`,
        },
        { status: 409 },
      );
    }
  } catch (error) {
    if (error instanceof SpineAPIError) {
      return NextResponse.json(
        error.response ?? { code: error.code, message: error.message },
        { status: error.statusCode },
      );
    }
  }

  if (component === 'system') {
    try {
      await assertNoCriticalIssues('Platform update');
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : String(err) },
        { status: 423 },
      );
    }
  }

  try {
    await startUpdate(component, '').catch(() => {});

    let result;

    switch (component) {
      case 'incus':
        await writeStatus(component, 'installing', 50, 'Updating Incus...').catch(() => {});
        result = await spineClient.updateIncus();
        break;
      case 'system':
        await writeStatus(component, 'installing', 50, 'Updating system packages...').catch(() => {});
        result = await spineClient.updateSystem();
        break;
      default:
        await writeStatus(component, 'installing', 50, `Updating ${component}...`).catch(() => {});
        result = await spineClient.updateApp(component);
        break;
    }

    await completeUpdate(component, '', result.new_version || '').catch(() => {});

    return NextResponse.json(result);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : 'Unknown error';
    await failUpdate(component, '', errMsg).catch(() => {});

    if (error instanceof SpineAPIError && error.statusCode === 409) {
      return NextResponse.json(
        error.response ?? { code: error.code ?? 'capability_not_supported', message: error.message },
        { status: 409 },
      );
    }

    console.error(`Failed to update ${component}:`, error);
    return NextResponse.json(
      { error: `Failed to update ${component}: ${errMsg}` },
      { status: 500 }
    );
  }
}
