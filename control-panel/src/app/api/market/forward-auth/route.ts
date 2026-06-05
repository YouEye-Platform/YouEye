/**
 * Forward-Auth Toggle API.
 * POST /api/market/forward-auth — enable/disable forward-auth for an installed app.
 *
 * Body: { appId: string, enabled: boolean }
 *
 * When enabling: adds a YouEye ID forward-auth handler to the Caddy route.
 * When disabling: strips the forward-auth handler from the Caddy route.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getInstalledApp, updateForwardAuthEnabled } from '@/lib/market/installed-apps';
import { readInstallMetadata, saveInstallMetadata } from '@/lib/market/metadata';
import { configureForwardAuth, getIdentityProviderConfig, removeForwardAuth } from '@/lib/identity/provider';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { appId, enabled } = body;

    if (!appId || typeof enabled !== 'boolean') {
      return NextResponse.json({ error: 'appId (string) and enabled (boolean) required' }, { status: 400 });
    }

    const app = await getInstalledApp(appId);
    if (!app) {
      return NextResponse.json({ error: `App ${appId} not installed` }, { status: 404 });
    }

    const metadata = await readInstallMetadata(appId);
    if (!metadata) {
      return NextResponse.json({ error: `No metadata for ${appId}` }, { status: 404 });
    }

    const hostname = `${metadata.subdomain}.${metadata.domain}`;

    if (enabled) {
      // Enable forward-auth
      const identity = await getIdentityProviderConfig();
      const faSlug = `youeye-fa-${appId}`;
      await configureForwardAuth({ hostname });

      // Update DB + metadata
      await updateForwardAuthEnabled(appId, true);
      metadata.forwardAuthEnabled = true;
      metadata.forwardAuthSlug = faSlug;
      await saveInstallMetadata(metadata);

      return NextResponse.json({ success: true, forwardAuthEnabled: true, provider: identity.provider });
    } else {
      // Disable forward-auth
      // Remove forward_auth handler from Caddy route
      try {
        await removeForwardAuth({ hostname });
      } catch {
        // Route may not have forward-auth
      }

      // Update DB + metadata
      await updateForwardAuthEnabled(appId, false);
      metadata.forwardAuthEnabled = false;
      metadata.forwardAuthSlug = undefined;
      await saveInstallMetadata(metadata);

      return NextResponse.json({ success: true, forwardAuthEnabled: false });
    }
  } catch (err) {
    console.error('[forward-auth] Toggle failed:', err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
