/**
 * PATCH /api/market/app/<appId>/source — point an installed app at another source of the same app.
 * Body: { sourceId, acceptUnverifiedPublisher?, allowSetup? }
 *
 * Its next update comes from that source, so the switch needs the same consent as an install from it: a custom
 * Market source must be accepted (`marketSourceRefusal`), an Added (URL) app needs its own flags (`directAppRefusal`).
 * Only the source identity changes (its id, name, repository and, for a git source, the repository path and branch its
 * manifests are read from); the installed copy and its digest stay as they are until the next update. This is the one
 * place that re-records an app's repository: an update refuses a source whose repository differs (`source-changed`).
 *
 * The target is resolved first (network); the install record is then read, changed and saved inside the app's
 * lifecycle lock, so an update that commits meanwhile is never overwritten with stale metadata.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdminCsrf } from '@/lib/auth/rbac';
import { resolveCatalogApp } from '@/lib/market/catalog';
import { getDirectMarketApp } from '@/lib/market/direct-apps';
import { readInstallMetadata, saveInstallMetadata } from '@/lib/market/metadata';
import { updateInstalledAppSource, upsertInstalledApp } from '@/lib/market/installed-apps';
import { directAppRefusal, isMarketSourceConsentError } from '@/lib/market/source';
import { withAppLifecycle, withUserOperationLockWait } from '@/lib/market/update-admission';
import { lifecycleBusyResponse } from '@/lib/http/lifecycle-busy';
import { logOperationFailure } from '@/lib/market/install-tracker';

export const dynamic = 'force-dynamic';

function refused(error: { message: string; code: string; setups?: unknown }) {
  return NextResponse.json({ error: error.message, code: error.code, ...(error.setups ? { setups: error.setups } : {}) },
    { status: error.code === 'source-unavailable' ? 400 : 403 });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ appId: string }> },
) {
  const auth = await requireAdminCsrf(request);
  if (auth.error) return auth.error;

  const { appId } = await params;
  const body = await request.json().catch(() => ({}));
  const sourceId = typeof body?.sourceId === 'string' ? body.sourceId.trim() : '';

  if (!appId || !sourceId) {
    return NextResponse.json({ error: 'appId and sourceId are required' }, { status: 400 });
  }

  if (!(await readInstallMetadata(appId))) {
    return NextResponse.json({ error: `App "${appId}" is not installed` }, { status: 404 });
  }

  let target: { sourceId: string; sourceName: string; sourceRepoUrl: string; url?: string; manifestRepo?: string; manifestBranch?: string };
  if (sourceId.startsWith('direct:')) {
    const direct = await getDirectMarketApp(sourceId, appId);
    if (!direct) {
      return NextResponse.json({ error: `App "${appId}" was not found in Market source "${sourceId}"` }, { status: 404 });
    }
    const refusal = directAppRefusal(direct.manifest.setups, body ?? {});
    if (refusal) return refused(refusal);
    target = { sourceId, sourceName: 'Added', sourceRepoUrl: direct.manifestUrl, url: direct.manifestUrl };
  } else {
    try {
      const resolved = await resolveCatalogApp(appId, sourceId);
      target = { sourceId: resolved.source.id, sourceName: resolved.source.name, sourceRepoUrl: resolved.source.repo_url };
      // Where a git source's manifests are read from; the update compares the branch with it.
      if (resolved.source.kind === 'git' && resolved.entry.integration !== 'native') {
        target.manifestRepo = resolved.reference.repo;
        target.manifestBranch = resolved.reference.branch;
      }
    } catch (error) {
      if (isMarketSourceConsentError(error)) return refused(error);
      return NextResponse.json({ error: `App "${appId}" was not found in Market source "${sourceId}"` }, { status: 404 });
    }
  }

  try {
    return await withUserOperationLockWait(() => withAppLifecycle(appId, async () => {
      const metadata = await readInstallMetadata(appId);
      if (!metadata) {
        return NextResponse.json({ error: `App "${appId}" is not installed` }, { status: 404 });
      }
      metadata.catalogKey = `${target.sourceId}:app:${appId}`;
      metadata.itemKind = 'app';
      metadata.sourceId = target.sourceId;
      metadata.sourceName = target.sourceName;
      metadata.sourceRepoUrl = target.sourceRepoUrl;
      metadata.manifestSource = target.sourceRepoUrl || metadata.manifestSource;
      if (target.manifestRepo !== undefined) metadata.manifestRepo = target.manifestRepo;
      if (target.manifestBranch !== undefined) metadata.manifestBranch = target.manifestBranch;

      await saveInstallMetadata(metadata);
      await upsertInstalledApp({
        appId,
        type: metadata.integration,
        installedVersion: metadata.installedVersion ?? '',
        subdomain: metadata.subdomain,
        ssoSlug: metadata.ssoSlug,
        forwardAuthEnabled: metadata.forwardAuthEnabled,
        catalogKey: metadata.catalogKey,
        sourceId: metadata.sourceId,
        sourceName: metadata.sourceName,
        sourceRepoUrl: metadata.sourceRepoUrl,
      });
      await updateInstalledAppSource(appId, target.url ? 'url' : 'catalog', target.url);

      return NextResponse.json({
        status: 'ok',
        appId,
        catalogKey: metadata.catalogKey,
        sourceId: metadata.sourceId,
        sourceName: metadata.sourceName,
        sourceRepoUrl: metadata.sourceRepoUrl,
      });
    }));
  } catch (error) {
    logOperationFailure(`Switching the source of ${appId}`, error);
    const busy = lifecycleBusyResponse(error);
    if (busy) return busy;
    if (error instanceof Error && error.name === 'AppLifecycleAdmissionError') {
      return NextResponse.json({ error: error.message, code: 'recovery_required' }, { status: 409 });
    }
    return NextResponse.json({ error: 'The app\'s source could not be switched; the cause is in the Control Panel journal.' }, { status: 500 });
  }
}
