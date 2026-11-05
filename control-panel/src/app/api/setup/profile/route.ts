/**
 * Certificate Trust Profile API
 *
 * GET /api/setup/profile?platform=ios|macos|windows|android|linux
 *
 * Returns platform-specific trust files:
 *   - ios/macos  → .mobileconfig (XML plist with CA cert payload)
 *   - windows/android → .crt (DER-encoded)
 *   - linux → .crt (PEM, same as /api/setup/ca-cert)
 */

import { type NextRequest } from 'next/server';
import { execShell } from '@/lib/incus/server';
import { settingsService } from '@/lib/settings';
import { pemToDer, deterministicUUID } from '@/lib/crypto/cert-utils';

type Platform = 'ios' | 'macos' | 'windows' | 'android' | 'linux';

const VALID_PLATFORMS: Platform[] = ['ios', 'macos', 'windows', 'android', 'linux'];

async function readCACert(): Promise<string> {
  const result = await execShell(
    'youeye-caddy',
    'cat /data/caddy/pki/authorities/local/root.crt',
    { timeout: 10000 },
  );
  if (result.exitCode !== 0 || !result.stdout.trim()) {
    throw new Error('CA certificate not available');
  }
  return result.stdout.trim();
}

function buildMobileconfig(pemCert: string, siteName: string, domain: string): string {
  const derBytes = pemToDer(pemCert);
  const certBase64 = derBytes.toString('base64');

  const uuidProfile = deterministicUUID(`profile-${domain}`);
  const uuidCertPayload = deterministicUUID(`cert-${domain}`);

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>PayloadContent</key>
\t<array>
\t\t<dict>
\t\t\t<key>PayloadCertificateFileName</key>
\t\t\t<string>youeye-ca.crt</string>
\t\t\t<key>PayloadContent</key>
\t\t\t<data>${certBase64}</data>
\t\t\t<key>PayloadDescription</key>
\t\t\t<string>Adds the ${escapeXml(siteName)} root CA to enable trusted HTTPS connections.</string>
\t\t\t<key>PayloadDisplayName</key>
\t\t\t<string>${escapeXml(siteName)} CA</string>
\t\t\t<key>PayloadIdentifier</key>
\t\t\t<string>youeye.cert.${escapeXml(domain)}</string>
\t\t\t<key>PayloadType</key>
\t\t\t<string>com.apple.security.root</string>
\t\t\t<key>PayloadUUID</key>
\t\t\t<string>${uuidCertPayload}</string>
\t\t\t<key>PayloadVersion</key>
\t\t\t<integer>1</integer>
\t\t</dict>
\t</array>
\t<key>PayloadDescription</key>
\t<string>Trust ${escapeXml(siteName)}'s HTTPS certificate so your browser connects securely without warnings.</string>
\t<key>PayloadDisplayName</key>
\t<string>${escapeXml(siteName)} Trust Profile</string>
\t<key>PayloadIdentifier</key>
\t<string>youeye.trust-profile.${escapeXml(domain)}</string>
\t<key>PayloadOrganization</key>
\t<string>${escapeXml(siteName)}</string>
\t<key>PayloadRemovalDisallowed</key>
\t<false/>
\t<key>PayloadType</key>
\t<string>Configuration</string>
\t<key>PayloadUUID</key>
\t<string>${uuidProfile}</string>
\t<key>PayloadVersion</key>
\t<integer>1</integer>
</dict>
</plist>`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export async function GET(request: NextRequest) {
  const platform = request.nextUrl.searchParams.get('platform') as Platform | null;

  if (!platform || !VALID_PLATFORMS.includes(platform)) {
    return Response.json(
      { error: `Invalid platform. Use one of: ${VALID_PLATFORMS.join(', ')}` },
      { status: 400 },
    );
  }

  try {
    const pem = await readCACert();
    const config = await settingsService.getRaw();
    const siteName = config.site_name || 'YouEye';
    const domain = config.domain || 'youeye.local';

    if (platform === 'ios' || platform === 'macos') {
      const xml = buildMobileconfig(pem, siteName, domain);
      const filename = `${siteName.replace(/[^a-zA-Z0-9]/g, '-')}-trust.mobileconfig`;
      return new Response(xml, {
        headers: {
          'Content-Type': 'application/x-apple-aspen-config',
          'Content-Disposition': `attachment; filename="${filename}"`,
          'Cache-Control': 'no-cache',
        },
      });
    }

    if (platform === 'windows' || platform === 'android') {
      const der = pemToDer(pem);
      return new Response(new Uint8Array(der), {
        headers: {
          'Content-Type': 'application/x-x509-ca-cert',
          'Content-Disposition': 'attachment; filename="youeye-ca.crt"',
          'Cache-Control': 'no-cache',
        },
      });
    }

    // linux — return PEM
    return new Response(pem, {
      headers: {
        'Content-Type': 'application/x-pem-file',
        'Content-Disposition': 'attachment; filename="youeye-ca.crt"',
        'Cache-Control': 'no-cache',
      },
    });
  } catch {
    return new Response('Failed to generate trust profile', { status: 500 });
  }
}
