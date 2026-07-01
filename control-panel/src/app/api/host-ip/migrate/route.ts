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
 * Body: { "old": "10.0.0.5", "new": "10.0.0.6", "force": false }
 * Response includes per-system success flags plus `*Required` flags.
 */

import { access } from 'node:fs/promises';
import { NextRequest } from 'next/server';
import { settingsService } from '@/lib/settings';
import { setDomainDNS } from '@/lib/apps/pihole-api';
import { removeIPLiteralRoute } from '@/lib/caddy/client';
import { tlsStorage } from '@/lib/acme/storage';
import { getByoDnsProviderConfig } from '@/lib/dns-providers/config';
import { syncByoDomainDns } from '@/lib/dns-providers/sync';
import { NAMES_ZONE, updateIp } from '@/lib/youeye-names/client';
import { IDENTITY_FILE_PATH } from '@/lib/youeye-names/identity';

export const dynamic = 'force-dynamic';

function isIPv4(s: string): boolean {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(s);
}

function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/\.+$/, '');
}

function leaseNameFromDomain(domain: string): string | null {
  const normalized = normalizeDomain(domain);
  const zone = normalizeDomain(NAMES_ZONE);
  const suffix = `.${zone}`;
  if (!normalized.endsWith(suffix)) return null;

  const label = normalized.slice(0, -suffix.length);
  if (!label || label.includes('.')) return null;
  return label;
}

async function hasYouEyeNamesIdentity(): Promise<boolean> {
  try {
    await access(IDENTITY_FILE_PATH);
    return true;
  } catch {
    return false;
  }
}

function isYouEyeNamesCertForDomain(
  cert: Awaited<ReturnType<typeof tlsStorage.getCert>>,
  domain: string,
): boolean {
  if (!cert) return false;
  if (cert.mode !== 'manual') return false;
  if (cert.issuer.trim().toLowerCase() !== 'youeye names') return false;

  const normalized = normalizeDomain(domain);
  return cert.domains.some((entry) => normalizeDomain(entry) === normalized);
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
  let force = false;
  try {
    const body = await request.json();
    oldIP = String(body.old || '');
    newIP = String(body.new || '');
    force = body.force === true;
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
  if (oldIP === newIP && !force) {
    return new Response(
      JSON.stringify({
        ok: true,
        dns: false,
        dnsRequired: false,
        providerDns: false,
        providerDnsRequired: false,
        youeyeNamesDns: false,
        youeyeNamesDnsRequired: false,
        caddy: false,
        force,
        noop: true,
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  }

  // ─── Read domain from settings ──────────────────────────
  let domain = '';
  try {
    const cfg = await settingsService.getRaw();
    domain = normalizeDomain(cfg.domain || '');
  } catch (err) {
    console.error('[host-ip/migrate] failed to read settings:', err);
  }

  // ─── 1. Pi-Hole dnsmasq_lines (best-effort) ─────────────
  // setDomainDNS auto-strips any existing `address=/${domain}/*` lines —
  // including the old IP — and writes the new one. If we have no domain
  // (setup hasn't completed yet), there's nothing to migrate.
  const dnsRequired = Boolean(domain);
  let dnsOk = false;
  if (dnsRequired) {
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

  let providerDnsRequired = false;
  let providerDnsOk = false;
  let providerDnsError: string | undefined;
  try {
    const providerConfig = await getByoDnsProviderConfig();
    providerDnsRequired = providerConfig?.mode === 'byo-provider';
  } catch (err) {
    providerDnsRequired = true;
    providerDnsError = err instanceof Error ? err.message : String(err);
    console.error('[host-ip/migrate] failed to read provider DNS config:', err);
  }
  try {
    if (!providerDnsError) {
      const result = await syncByoDomainDns('host-ip-change', newIP);
      providerDnsOk = result.ok;
      providerDnsError = result.error;
      if (result.domain) {
        console.log(`[host-ip/migrate] provider DNS sync for ${result.domain}: ${result.ok ? 'ok' : result.error}`);
      }
    }
  } catch (err) {
    providerDnsError = err instanceof Error ? err.message : String(err);
    console.error('[host-ip/migrate] provider DNS sync failed:', err);
  }

  // ─── YouEye Names lease DNS (strict when this install owns one) ─────
  let youeyeNamesDnsRequired = false;
  let youeyeNamesDnsOk = false;
  let youeyeNamesError: string | undefined;
  const leaseName = domain ? leaseNameFromDomain(domain) : null;
  if (leaseName) {
    try {
      const cert = await tlsStorage.getCert();
      if (isYouEyeNamesCertForDomain(cert, domain)) {
        youeyeNamesDnsRequired = true;
        if (!(await hasYouEyeNamesIdentity())) {
          throw new Error('YouEye Names certificate is installed but the local install identity is missing');
        }
        await updateIp(leaseName, newIP);
        youeyeNamesDnsOk = true;
        console.log(`[host-ip/migrate] YouEye Names DNS sync for ${domain}: ok`);
      } else {
        console.log('[host-ip/migrate] skipping YouEye Names DNS sync — domain is not backed by a YouEye Names certificate');
      }
    } catch (err) {
      youeyeNamesError = err instanceof Error ? err.message : String(err);
      console.error('[host-ip/migrate] YouEye Names DNS sync failed:', err);
    }
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
      force,
      domain: domain || null,
      dns: dnsOk,
      dnsRequired,
      providerDns: providerDnsOk,
      providerDnsRequired,
      providerDnsError: providerDnsError || null,
      youeyeNamesDns: youeyeNamesDnsOk,
      youeyeNamesDnsRequired,
      youeyeNamesError: youeyeNamesError || null,
      caddy: caddyOk,
    }),
    { headers: { 'Content-Type': 'application/json' } }
  );
}
