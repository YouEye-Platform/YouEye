/**
 * Host-IP migration endpoint.
 *
 * Called by Spine's host-IP-change check (runHostIPCheck in
 * YE-Spine/internal/cmd/hostipcheck.go) AFTER it has already migrated the
 * two host-side pins (Pi-Hole proxy device, CP systemd HOST_IP env). This
 * endpoint handles the two CP-side pins:
 *
 *  1. Pi-Hole dnsmasq_lines wildcard rewrite (`address=/${domain}/${oldIP}`)
 *     — replaced with `address=/${domain}/${newIP}` via setDomainDNS, which
 *     already strips any prior entries for the same domain.
 *
 *  2. Caddy IP-literal route (legacy installs only) — a route created by
 *     deployer.ts <= 0.2.18.2 with `match[0].host === [oldIP]`. Removed via
 *     removeIPLiteralRoute. The `:443` catch-all already serves CP from any
 *     IP, so deletion (vs rewriting) is the right answer.
 *
 * Auth: server-to-server only. Spine reads /var/lib/youeye/control/.deploy_secret
 * (written when the youeye-control container is created in
 * YE-Spine/internal/container/control.go) and passes it via X-Deploy-Secret.
 * The same secret is plumbed into the CP container as TEST_ADMIN_SECRET.
 * This is the same auth pattern used by /api/deploy/infrastructure.
 *
 * POST /api/host-ip/migrate
 * Headers: X-Deploy-Secret: <secret>
 * Body: { "old": "10.0.0.5", "new": "10.0.0.6" }
 * Response: { "ok": true, "dns": <bool>, "caddy": <bool>, "domain": "..." }
 */

import { NextRequest } from 'next/server';
import { settingsService } from '@/lib/settings';
import { setDomainDNS } from '@/lib/apps/pihole-api';
import { removeIPLiteralRoute } from '@/lib/caddy/client';

export const dynamic = 'force-dynamic';

function isIPv4(s: string): boolean {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(s);
}

export async function POST(request: NextRequest) {
  // ─── Auth ───────────────────────────────────────────────
  const secret = request.headers.get('X-Deploy-Secret');
  const expectedSecret = process.env.TEST_ADMIN_SECRET;
  if (!expectedSecret || secret !== expectedSecret) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // ─── Parse body ─────────────────────────────────────────
  let oldIP: string;
  let newIP: string;
  try {
    const body = await request.json();
    oldIP = String(body.old || '');
    newIP = String(body.new || '');
    if (!isIPv4(oldIP) || !isIPv4(newIP)) {
      throw new Error('old and new must be IPv4 addresses');
    }
  } catch (err) {
    return new Response(
      JSON.stringify({
        error: 'Invalid body — expected { "old": "1.2.3.4", "new": "5.6.7.8" }',
        detail: String(err),
      }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // No-op fast path.
  if (oldIP === newIP) {
    return new Response(
      JSON.stringify({ ok: true, dns: false, caddy: false, noop: true }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  }

  // ─── Read domain from settings ──────────────────────────
  let domain = '';
  try {
    const cfg = await settingsService.getRaw();
    domain = cfg.domain || '';
  } catch (err) {
    console.error('[host-ip/migrate] failed to read settings:', err);
  }

  // ─── 1. Pi-Hole dnsmasq_lines (best-effort) ─────────────
  // setDomainDNS auto-strips any existing `address=/${domain}/*` lines —
  // including the old IP — and writes the new one. If we have no domain
  // (setup hasn't completed yet), there's nothing to migrate.
  let dnsOk = false;
  if (domain) {
    try {
      await setDomainDNS(domain, newIP);
      dnsOk = true;
      console.log(`[host-ip/migrate] dnsmasq_lines: *.${domain} → ${newIP}`);
    } catch (err) {
      console.error('[host-ip/migrate] setDomainDNS failed:', err);
    }
  } else {
    console.log('[host-ip/migrate] skipping dnsmasq update — no domain in settings');
  }

  // ─── 2. Caddy IP-literal route (best-effort) ────────────
  let caddyOk = false;
  try {
    caddyOk = await removeIPLiteralRoute(oldIP);
    if (caddyOk) {
      console.log(`[host-ip/migrate] removed legacy Caddy IP-literal route for ${oldIP}`);
    } else {
      console.log(`[host-ip/migrate] no legacy Caddy IP-literal route for ${oldIP} (already clean)`);
    }
  } catch (err) {
    console.error('[host-ip/migrate] removeIPLiteralRoute failed:', err);
  }

  return new Response(
    JSON.stringify({
      ok: true,
      old: oldIP,
      new: newIP,
      domain: domain || null,
      dns: dnsOk,
      caddy: caddyOk,
    }),
    { headers: { 'Content-Type': 'application/json' } }
  );
}
