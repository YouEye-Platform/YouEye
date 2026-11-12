/**
 * Manifest URL Validation Endpoint
 *
 * POST /api/market/validate-url
 * Body: { manifestUrl: string }
 *
 * Fetches a YAML manifest from a URL, validates it against the schema,
 * and returns the parsed manifest or validation errors.
 *
 * Security:
 *   - HTTPS only (no http://, file://, etc.)
 *   - SSRF prevention: blocks RFC1918 private IPs
 *   - Max response size: 1MB
 *   - Timeout: 5 seconds
 *   - Safe YAML parsing (no executable content)
 */

import { NextRequest, NextResponse } from 'next/server';
import type { AppManifest, MarketApp } from '@/lib/market/types';
import { fetchUrlApp, isPrivateHostname, UrlAppError, validateAppUrl } from '@/lib/market/url-app';
import { requireAdmin } from '@/lib/auth/rbac';
import { saveDirectMarketApp } from '@/lib/market/direct-apps';

export const dynamic = 'force-dynamic';

/**
 * Convert a parsed manifest to a MarketApp preview for the UI.
 */
function manifestToPreview(manifest: AppManifest): MarketApp {
  return {
    id: manifest.metadata.id,
    name: manifest.metadata.name,
    description: manifest.metadata.description,
    icon: manifest.metadata.icon,
    iconUrl: manifest.metadata.iconUrl,
    category: manifest.metadata.category,
    integration: manifest.integration,
    version: manifest.version,
    defaultSubdomain: manifest.metadata.defaultSubdomain,
    supportsSSO: !!manifest.sso,
    website: manifest.metadata.website,
    tags: manifest.metadata.tags,
    detail: manifest.detail ? {
      longDescription: manifest.detail.longDescription,
      screenshots: manifest.detail.screenshots.map((s) => ({
        url: s.path,
        caption: s.caption,
      })),
    } : undefined,
  };
}

export async function POST(request: NextRequest) {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;

  let body: { manifestUrl?: string; addToMarket?: boolean; allowSetup?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { valid: false, errors: ['Invalid JSON body'] },
      { status: 400 }
    );
  }

  const { manifestUrl } = body;
  if (!manifestUrl || typeof manifestUrl !== 'string') {
    return NextResponse.json(
      { valid: false, errors: ['manifestUrl is required'] },
      { status: 400 }
    );
  }

  // Detect GitHub repo URLs and transform to raw manifest URL
  // Pattern: https://github.com/{owner}/{repo} (with optional trailing slash)
  const githubRepoPattern = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)\/?$/;
  const githubMatch = manifestUrl.match(githubRepoPattern);
  let forgejoManifestUrl: string | null = null;
  if (!githubMatch) {
    try {
      const repository = new URL(manifestUrl);
      const parts = repository.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').split('/');
      if (repository.protocol === 'https:' && !repository.username && !repository.password &&
          !repository.search && !repository.hash && parts.length === 2 && parts.every(Boolean) &&
          !isPrivateHostname(repository.hostname)) {
        forgejoManifestUrl = `${repository.origin}/${parts.map(encodeURIComponent).join('/')}/raw/branch/main/youeye-app.yaml`;
      }
    } catch {
      forgejoManifestUrl = null;
    }
  }
  const resolvedUrl = githubMatch
    ? `https://raw.githubusercontent.com/${githubMatch[1]}/${githubMatch[2]}/main/youeye-app.yaml`
    : forgejoManifestUrl ?? manifestUrl;

  // Step 1: Validate URL safety
  const urlError = validateAppUrl(resolvedUrl);
  if (urlError) {
    return NextResponse.json(
      { valid: false, errors: [urlError] },
      { status: 400 }
    );
  }

  // Step 2: Fetch and parse the app (manifest + setup files) with the one app-format parser
  let manifest: AppManifest;
  try {
    manifest = await fetchUrlApp(resolvedUrl);
  } catch (error) {
    const errors = error instanceof UrlAppError
      ? (error.details.length ? error.details : [error.message])
      : ['Failed to fetch manifest'];
    return NextResponse.json({ valid: false, errors }, { status: 400 });
  }

  // Step 3: an app with setup files runs them inside its containers; it is only accepted
  // with an explicit approval (the CLI's --allow-setup, the dialog's checkbox).
  if (manifest.setups.length > 0 && body.allowSetup !== true) {
    return NextResponse.json({
      valid: false,
      setupApprovalRequired: true,
      errors: ['This app runs setup files inside its containers; confirm them before adding it (allowSetup)'],
      setups: manifest.setups.map((setup) => ({ name: setup.name, for: setup.for })),
    }, { status: 400 });
  }

  // Step 4: Return validated manifest preview
  const preview = manifestToPreview(manifest);
  const directEntry = body.addToMarket
    ? await saveDirectMarketApp({ manifestUrl: resolvedUrl, manifest })
    : null;

  // Log the URL install attempt for audit
  console.log(`[Market] Manifest validated from URL: ${resolvedUrl} — app: ${manifest.metadata.id} v${manifest.version || 'unknown'}`);

  return NextResponse.json({
    valid: true,
    manifest: preview,
    sourceId: directEntry?.sourceId,
    appId: directEntry?.manifest.metadata.id,
    href: directEntry
      ? `/market/${encodeURIComponent(directEntry.manifest.metadata.id)}?source=${encodeURIComponent(directEntry.sourceId)}`
      : undefined,
    capabilities: {
      sso: !!manifest.sso,
      sharedPostgres: manifest.database?.mode === 'shared',
      containers: manifest.containers.length,
      notifications: manifest.capabilities?.notifications,
      smtp: manifest.capabilities?.smtp,
      setups: manifest.setups.map((setup) => ({ name: setup.name, for: setup.for })),
    },
  });
}
