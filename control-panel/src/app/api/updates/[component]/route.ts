import { NextRequest, NextResponse } from 'next/server';
import { SpineAPIError, spineClient, type SpineRuntimeCapabilities } from '@/lib/spine/client';
import { getSession, verifyCSRFToken } from '@/lib/auth/session';
import { startUpdate, writeStatus, completeUpdate, completeNoOp, failUpdate } from '@/lib/updates/state';
import { getAppDefinition } from '@/lib/apps/definitions';
import { updateLXDApp } from '@/lib/apps/lxd-updater';
import { effectiveChannel, resolveCandidate } from '@/lib/updates/channels';
import { getCoreProvenance, recordCoreProvenance } from '@/lib/updates/provenance';
import { isNewer } from '@/lib/version';
import { assertNoCriticalIssues } from '@/lib/health/issues';

// POST /api/updates/[component] - Trigger update for a component
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

  const capabilityForComponent: Partial<Record<string, keyof SpineRuntimeCapabilities>> = {
    spine: 'spine_update',
    incus: 'incus_update',
    system: 'system_update',
    control: 'control_update',
    ui: 'ui_update',
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
    // Older Spine versions do not return the runtime object. Preserve their
    // mutable-host behavior; the authoritative Spine mutation endpoint still
    // enforces the capability before work begins.
    if (error instanceof SpineAPIError) {
      return NextResponse.json(
        error.response ?? { code: error.code, message: error.message },
        { status: error.statusCode },
      );
    }
  }

  if (component === 'spine' || component === 'control' || component === 'ui' || component === 'system') {
    try {
      await assertNoCriticalIssues('Platform update');
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : String(err) },
        { status: 423 },
      );
    }
  }

  // Body is optional; only { confirm_switch: true } is read. Tolerate empty bodies.
  let confirmSwitch = false;
  try {
    const body = await request.json();
    confirmSwitch = body?.confirm_switch === true;
  } catch {
    confirmSwitch = false;
  }

  try {
    await startUpdate(component, '').catch(() => {});

    // UI is an LXD app updated by the Control Panel directly. Resolve its release
    // through the ui channel and record ui provenance in the CP json-store.
    if (component === 'ui') {
      const appDef = getAppDefinition('ui');
      if (!appDef) {
        return NextResponse.json({ error: 'UI app definition not found' }, { status: 500 });
      }

      // Channel resolution: detect a pending channel SWITCH (candidate on a
      // different branch than what is installed). Without confirm_switch this
      // returns 409 — same semantics as spine's POST /api/update/self|control.
      let candidate: Awaited<ReturnType<typeof resolveCandidate>> = null;
      try {
        const ch = await effectiveChannel('ui');
        candidate = await resolveCandidate(ch, 'ui', ch.source);
      } catch (err) {
        console.warn('[updates] ui channel resolution failed:', err);
      }

      const prevProvenance = await getCoreProvenance('ui');
      const installedBranch = prevProvenance?.branch || 'main';
      // A strictly newer candidate is a plain update regardless of branch
      // (fallback overtake); the confirm gate is only for not-newer switches.
      let candidateIsNewer = true;
      if (candidate && prevProvenance?.version) {
        try {
          candidateIsNewer = isNewer(candidate.version, prevProvenance.version);
        } catch {
          candidateIsNewer = false;
        }
      }
      if (candidate && candidate.branch !== installedBranch && !candidateIsNewer && !confirmSwitch) {
        await failUpdate(component, '', 'channel switch requires confirmation').catch(() => {});
        return NextResponse.json(
          {
            error: 'Channel switch requires confirmation',
            switch_pending: true,
            installed: { branch: installedBranch, version: prevProvenance?.version ?? null },
            candidate: { branch: candidate.branch, version: candidate.version, tag: candidate.tag },
          },
          { status: 409 },
        );
      }

      // Already on the candidate tag → no-op (don't reinstall on every call).
      if (candidate && prevProvenance?.tag === candidate.tag) {
        await completeUpdate(component, '', candidate.version).catch(() => {});
        return NextResponse.json({
          status: 'success',
          message: `UI is already up to date (${candidate.version})`,
          version: candidate.version,
          branch: candidate.branch,
        });
      }

      let lastEvent: { message?: string } = {};
      await updateLXDApp(
        appDef,
        (event) => { lastEvent = event; },
        candidate ? { version: candidate.version, tag: candidate.tag, artifactSHA256: candidate.artifactSHA256 } : undefined,
      );

      // Record provenance from the resolved candidate (best-effort — a failure to
      // record must not fail the update the user already applied).
      if (candidate) {
        await recordCoreProvenance('ui', {
          version: candidate.version,
          tag: candidate.tag,
          branch: candidate.branch,
          source: (await effectiveChannel('ui').catch(() => null))?.source ?? null,
          artifactSHA256: candidate.artifactSHA256 ?? null,
        }).catch((err) => console.error('[updates] failed to record ui provenance:', err));
      }

      await completeUpdate(component, '', candidate?.version ?? '').catch(() => {});
      return NextResponse.json({
        status: 'success',
        message: lastEvent.message || 'UI updated',
        version: candidate?.version ?? null,
        branch: candidate?.branch ?? null,
      });
    }

    let result;

    switch (component) {
      case 'spine':
        result = await spineClient.updateSelf({ confirmSwitch });
        break;
      case 'control':
        result = await spineClient.updateControl({ confirmSwitch });
        break;
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

    // For non-Spine-managed updates, mark completed in DB
    if (['spine', 'control'].includes(component) && result.status === 'up-to-date') {
      await completeNoOp(component, result.new_version || result.old_version || '');
    } else if (!['spine', 'control'].includes(component)) {
      const newVer = result.new_version || '';
      await completeUpdate(component, '', newVer).catch(() => {});
    }

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
