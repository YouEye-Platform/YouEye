/**
 * UI Bridge: App Subdomain Change
 *
 * PUT /api/ui-bridge/apps/subdomain
 *
 * Changes an installed app's subdomain. This is an admin-only operation
 * that updates all systems that reference the subdomain:
 *
 * 1. Caddy reverse proxy route (remove old hostname, add new hostname)
 * 2. Authentik OAuth2 redirect URIs (if app uses SSO)
 * 3. Install metadata (/var/lib/youeye/app-{id}/install.json)
 * 4. installed_apps DB table (subdomain column)
 *
 * The YE-UI side updates its own `apps` table separately after this succeeds.
 *
 * Request body:
 *   { appId: string, oldSubdomain: string, newSubdomain: string }
 *
 * IMPORTANT FOR FUTURE AGENTS:
 * When an app's subdomain changes, ALL of these must be updated in sync.
 * If any step fails, the app may become unreachable or SSO may break.
 * The operation attempts all steps and reports which ones succeeded/failed.
 * Caddy route update is the most critical — without it the app is unreachable.
 * Authentik update is only needed if the app has SSO enabled.
 */

import { NextRequest, NextResponse } from 'next/server';
import { validateBridgeToken } from '@/lib/ui-bridge/auth';
import { getRoutes, removeRoute, addRoute } from '@/lib/caddy/client';
import { readInstallMetadata, saveInstallMetadata } from '@/lib/market/metadata';
import {
  authentikAPI,
  getAuthentikConfig,
  isAuthentikAvailable,
} from '@/lib/market/authentik';

interface SubdomainChangeRequest {
  appId: string;
  oldSubdomain: string;
  newSubdomain: string;
}

export async function PUT(request: NextRequest) {
  const authError = await validateBridgeToken(request);
  if (authError) return authError;

  let body: SubdomainChangeRequest;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { appId, oldSubdomain, newSubdomain } = body;

  if (!appId || !oldSubdomain || !newSubdomain) {
    return NextResponse.json(
      { error: 'appId, oldSubdomain, and newSubdomain are required' },
      { status: 400 }
    );
  }

  if (oldSubdomain === newSubdomain) {
    return NextResponse.json({ success: true, message: 'No change needed' });
  }

  // Validate subdomain format
  if (!/^[a-z0-9-]+$/.test(newSubdomain)) {
    return NextResponse.json(
      { error: 'Subdomain must contain only lowercase letters, numbers, and hyphens' },
      { status: 400 }
    );
  }

  const results: Record<string, { success: boolean; error?: string }> = {};

  // Read install metadata to get domain and SSO info
  const meta = await readInstallMetadata(appId);
  const domain = meta?.domain;

  if (!domain) {
    return NextResponse.json(
      { error: `No install metadata found for app '${appId}'. Cannot determine domain.` },
      { status: 404 }
    );
  }

  const oldHostname = `${oldSubdomain}.${domain}`;
  const newHostname = `${newSubdomain}.${domain}`;

  // ── Step 1: Update Caddy route ──────────────────────────

  try {
    const routes = await getRoutes();
    const existingRoute = routes.find((r) => r.hostname === oldHostname);

    if (existingRoute) {
      // Remove old route and add new one with updated hostname
      await removeRoute(existingRoute.id);
      await addRoute({
        hostname: newHostname,
        path: existingRoute.path || '/*',
        upstream: existingRoute.upstream,
        port: existingRoute.port,
      });
      results.caddy = { success: true };
    } else {
      results.caddy = { success: false, error: `No Caddy route found for ${oldHostname}` };
    }
  } catch (err) {
    results.caddy = { success: false, error: String(err) };
  }

  // ── Step 2: Update Authentik OAuth2 redirect URIs ───────

  if (meta.enableSSO && meta.ssoSlug) {
    try {
      const authentikAvailable = await isAuthentikAvailable();
      if (authentikAvailable) {
        const config = await getAuthentikConfig();

        // Find the OAuth2 provider for this app
        const providers = await authentikAPI<{
          results: Array<{ pk: number; client_id?: string; redirect_uris: Array<{ url: string; matching_mode: string }> }>;
        }>(config, '/providers/oauth2/?page_size=100');

        const provider = providers.results?.find(
          (p) => p.client_id === meta.ssoSlug
        );

        if (provider) {
          // Update redirect URIs: replace old subdomain with new
          const updatedUris = provider.redirect_uris.map((uri) => ({
            ...uri,
            url: uri.url.replace(oldSubdomain, newSubdomain),
          }));

          await authentikAPI(
            config,
            `/providers/oauth2/${provider.pk}/`,
            'PATCH',
            { redirect_uris: updatedUris }
          );

          // Update application launch URL
          await authentikAPI(
            config,
            `/core/applications/${meta.ssoSlug}/`,
            'PATCH',
            { meta_launch_url: `https://${newHostname}` }
          );

          results.authentik = { success: true };
        } else {
          results.authentik = {
            success: false,
            error: `No OAuth2 provider found with client_id '${meta.ssoSlug}'`,
          };
        }
      } else {
        results.authentik = { success: false, error: 'Authentik not available' };
      }
    } catch (err) {
      results.authentik = { success: false, error: String(err) };
    }
  } else {
    results.authentik = { success: true };
  }

  // ── Step 3: Update install metadata ─────────────────────

  try {
    if (meta) {
      meta.subdomain = newSubdomain;
      await saveInstallMetadata(meta);
      results.metadata = { success: true };
    }
  } catch (err) {
    results.metadata = { success: false, error: String(err) };
  }

  // ── Step 4: Update installed_apps DB table ──────────────

  try {
    const { updateInstalledAppSubdomain } = await import('@/lib/market/installed-apps');
    await updateInstalledAppSubdomain(appId, newSubdomain);
    results.database = { success: true };
  } catch (err) {
    results.database = { success: false, error: String(err) };
  }

  // ── Report ──────────────────────────────────────────────

  const allSuccess = Object.values(results).every((r) => r.success);

  return NextResponse.json(
    {
      success: allSuccess,
      oldSubdomain,
      newSubdomain,
      domain,
      results,
    },
    { status: allSuccess ? 200 : 207 }
  );
}
