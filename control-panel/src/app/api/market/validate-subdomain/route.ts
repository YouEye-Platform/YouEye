/**
 * GET /api/market/validate-subdomain?subdomain=foo&domain=youeye.local
 * Returns { available: true } or { available: false, reason: "Already used by app X" }
 *
 * Proactively checks whether a subdomain is already claimed before an app
 * install attempt, preventing the mid-install Caddy duplicate-route failure.
 *
 * Three sources are checked in order:
 *  1. The `installed_apps` PostgreSQL table (authoritative)
 *  2. File-based install.json metadata (fallback for pre-migration installs)
 *  3. Live Caddy routes (catches manually-added or orphaned routes)
 */

import { NextResponse } from 'next/server';
import { getAllInstalledApps } from '@/lib/market/installed-apps';
import { listInstalledApps } from '@/lib/market/metadata';
import { getRoutes } from '@/lib/caddy/client';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const subdomain = searchParams.get('subdomain');
  const domain = searchParams.get('domain');

  if (!subdomain) {
    return NextResponse.json({ error: 'subdomain is required' }, { status: 400 });
  }

  try {
    // 1. Check the PostgreSQL installed_apps table
    const dbApps = await getAllInstalledApps();
    const dbConflict = dbApps.find((a) => a.subdomain === subdomain);
    if (dbConflict) {
      return NextResponse.json({
        available: false,
        reason: `Already used by ${dbConflict.appId}`,
      });
    }

    // 2. Check file-based metadata as fallback
    const fileApps = await listInstalledApps();
    const fileConflict = fileApps.find((a) => a.subdomain === subdomain);
    if (fileConflict) {
      return NextResponse.json({
        available: false,
        reason: `Already used by ${fileConflict.appId}`,
      });
    }

    // 3. Check live Caddy routes for hostname conflicts
    try {
      const routes = await getRoutes();
      const fqdn = domain ? `${subdomain}.${domain}` : null;
      const caddyConflict = routes.find((r) => {
        if (!r.hostname) return false;
        // Match either the exact FQDN or a hostname starting with the subdomain
        if (fqdn && r.hostname === fqdn) return true;
        if (r.hostname.startsWith(`${subdomain}.`)) return true;
        return false;
      });
      if (caddyConflict) {
        return NextResponse.json({
          available: false,
          reason: `Caddy route already exists for ${caddyConflict.hostname}`,
        });
      }
    } catch {
      // Caddy may be unreachable — continue without this check
    }

    return NextResponse.json({ available: true });
  } catch (err) {
    // Fail open: if we can't check, allow the install to proceed
    // (it will still fail at Caddy if there's a real conflict)
    console.error('[validate-subdomain] Error checking subdomain:', err);
    return NextResponse.json({ available: true });
  }
}
