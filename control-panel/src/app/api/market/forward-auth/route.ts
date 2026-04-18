/**
 * Forward-Auth Toggle API.
 * POST /api/market/forward-auth — enable/disable forward-auth for an installed app.
 *
 * Body: { appId: string, enabled: boolean }
 *
 * When enabling: creates Authentik forward-auth proxy + adds forward_auth handler to Caddy route.
 * When disabling: removes Authentik forward-auth proxy + strips forward_auth handler from Caddy route.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getInstalledApp, updateForwardAuthEnabled } from '@/lib/market/installed-apps';
import { readInstallMetadata, saveInstallMetadata } from '@/lib/market/metadata';
import {
  createAuthentikForwardAuthApp,
  removeAuthentikForwardAuthApp,
  isAuthentikAvailable,
} from '@/lib/market/authentik';
import { addForwardAuthToRoute, removeForwardAuthFromRoute } from '@/lib/caddy/client';
import { getContainerIP } from '@/lib/incus/container-ip';

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
      if (!(await isAuthentikAvailable())) {
        return NextResponse.json({ error: 'Authentik not available' }, { status: 503 });
      }

      const faSlug = `youeye-fa-${appId}`;
      const externalHost = `https://${hostname}`;

      // Create Authentik forward-auth proxy provider
      await createAuthentikForwardAuthApp({
        slug: faSlug,
        name: `YouEye - ${metadata.appId}`,
        externalHost,
      });

      // Add forward_auth handler to existing Caddy route
      const authentikIP = await getContainerIP('youeye-authentik');
      if (authentikIP) {
        await addForwardAuthToRoute(hostname, {
          uri: `http://${authentikIP}:9000/outpost.goauthentik.io/auth/caddy`,
          copyHeaders: [
            'X-authentik-username',
            'X-authentik-groups',
            'X-authentik-email',
            'X-authentik-name',
            'X-authentik-uid',
          ],
        });
      }

      // Update DB + metadata
      await updateForwardAuthEnabled(appId, true);
      metadata.forwardAuthEnabled = true;
      metadata.forwardAuthSlug = faSlug;
      await saveInstallMetadata(metadata);

      return NextResponse.json({ success: true, forwardAuthEnabled: true });
    } else {
      // Disable forward-auth
      const faSlug = metadata.forwardAuthSlug || `youeye-fa-${appId}`;

      // Remove Authentik forward-auth proxy
      try {
        await removeAuthentikForwardAuthApp(faSlug);
      } catch {
        // May not exist
      }

      // Remove forward_auth handler from Caddy route
      try {
        await removeForwardAuthFromRoute(hostname);
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
