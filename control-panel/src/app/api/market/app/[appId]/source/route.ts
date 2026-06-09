import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { fetchAvailableApps } from '@/lib/market/catalog';
import { readInstallMetadata, saveInstallMetadata } from '@/lib/market/metadata';
import { upsertInstalledApp } from '@/lib/market/installed-apps';

export const dynamic = 'force-dynamic';

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ appId: string }> },
) {
  const session = await getSession();
  if (!session?.isAdmin) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  }

  const { appId } = await params;
  const body = await request.json().catch(() => ({}));
  const sourceId = typeof body?.sourceId === 'string' ? body.sourceId : '';

  if (!appId || !sourceId) {
    return NextResponse.json({ error: 'appId and sourceId are required' }, { status: 400 });
  }

  const metadata = await readInstallMetadata(appId);
  if (!metadata) {
    return NextResponse.json({ error: `App "${appId}" is not installed` }, { status: 404 });
  }

  const apps = await fetchAvailableApps();
  const selected = apps.find((app) => app.id === appId && app.sourceId === sourceId);
  if (!selected) {
    return NextResponse.json(
      { error: `App "${appId}" was not found in Market source "${sourceId}"` },
      { status: 404 },
    );
  }

  metadata.catalogKey = selected.catalogKey || `${sourceId}:app:${appId}`;
  metadata.itemKind = selected.itemKind || 'app';
  metadata.sourceId = selected.sourceId;
  metadata.sourceName = selected.sourceName;
  metadata.sourceRepoUrl = selected.sourceRepoUrl;
  metadata.manifestSource = selected.sourceRepoUrl || metadata.manifestSource;
  metadata.manifestPath = selected.manifestPath;
  metadata.manifestRepo = selected.manifestRepo;
  metadata.manifestBranch = selected.manifestBranch;
  metadata.manifestDigest = selected.manifestDigest;

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

  return NextResponse.json({
    status: 'ok',
    appId,
    catalogKey: metadata.catalogKey,
    sourceId: metadata.sourceId,
    sourceName: metadata.sourceName,
    sourceRepoUrl: metadata.sourceRepoUrl,
    manifestPath: metadata.manifestPath,
    manifestRepo: metadata.manifestRepo,
    manifestBranch: metadata.manifestBranch,
    manifestDigest: metadata.manifestDigest,
  });
}
