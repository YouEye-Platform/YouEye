/**
 * Certificate Download API
 *
 * GET /api/tls/download?type=cert|key|ca|bundle
 *   - cert: Download the current certificate (PEM)
 *   - key: Download the private key (PEM)
 *   - ca: Download Caddy's internal CA root cert (PEM) — for browser trust
 *   - bundle: Download cert + key together as a JSON object
 */

import { type NextRequest } from 'next/server';
import { getSession } from '@/lib/auth';
import { tlsStorage } from '@/lib/acme/storage';
import { execShell } from '@/lib/incus/server';

type DownloadType = 'cert' | 'key' | 'ca' | 'bundle' | 'zip';
const VALID_TYPES: DownloadType[] = ['cert', 'key', 'ca', 'bundle', 'zip'];

export async function GET(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.isAdmin) {
      return new Response('Unauthorized', { status: 401 });
    }

    const type = request.nextUrl.searchParams.get('type') as DownloadType | null;
    if (!type || !VALID_TYPES.includes(type)) {
      return Response.json(
        { error: `Invalid type. Use one of: ${VALID_TYPES.join(', ')}` },
        { status: 400 },
      );
    }

    // CA cert — always available (from Caddy's internal CA)
    if (type === 'ca') {
      const result = await execShell(
        'youeye-caddy',
        'cat /data/caddy/pki/authorities/local/root.crt',
        { timeout: 10000 },
      );
      if (result.exitCode !== 0 || !result.stdout.trim()) {
        return new Response('CA certificate not available', { status: 404 });
      }
      return new Response(result.stdout, {
        headers: {
          'Content-Type': 'application/x-pem-file',
          'Content-Disposition': 'attachment; filename="youeye-ca.crt"',
          'Cache-Control': 'no-cache',
        },
      });
    }

    // Cert, key, bundle, or zip — requires stored external cert
    const stored = await tlsStorage.getCert();
    if (!stored) {
      return Response.json(
        { error: 'No external certificate is stored. The server is using self-signed certificates.' },
        { status: 404 },
      );
    }

    // ZIP — cert + key bundled as a zip archive
    if (type === 'zip') {
      // Build a minimal ZIP file with cert.pem and key.pem
      const certBuf = new TextEncoder().encode(stored.certPem);
      const keyBuf = new TextEncoder().encode(stored.keyPem);
      const zipData = buildZip([
        { name: 'cert.pem', data: certBuf },
        { name: 'key.pem', data: keyBuf },
      ]);
      return new Response(Buffer.from(zipData), {
        headers: {
          'Content-Type': 'application/zip',
          'Content-Disposition': 'attachment; filename="youeye-tls-keys.zip"',
          'Cache-Control': 'no-cache',
        },
      });
    }

    if (type === 'cert') {
      return new Response(stored.certPem, {
        headers: {
          'Content-Type': 'application/x-pem-file',
          'Content-Disposition': 'attachment; filename="youeye-cert.pem"',
          'Cache-Control': 'no-cache',
        },
      });
    }

    if (type === 'key') {
      return new Response(stored.keyPem, {
        headers: {
          'Content-Type': 'application/x-pem-file',
          'Content-Disposition': 'attachment; filename="youeye-key.pem"',
          'Cache-Control': 'no-cache',
        },
      });
    }

    // bundle
    return Response.json(
      {
        certificate: stored.certPem,
        privateKey: stored.keyPem,
        domains: stored.domains,
        issuer: stored.issuer,
        expiresAt: stored.expiresAt,
        issuedAt: stored.issuedAt,
      },
      {
        headers: {
          'Content-Disposition': 'attachment; filename="youeye-tls-bundle.json"',
          'Cache-Control': 'no-cache',
        },
      },
    );
  } catch (error) {
    console.error('[TLS/Download] Failed:', error);
    return new Response('Failed to download certificate', { status: 500 });
  }
}

// ─── Minimal ZIP builder (no external deps) ──────────────────────────────────

interface ZipEntry {
  name: string;
  data: Uint8Array;
}

function buildZip(entries: ZipEntry[]): Uint8Array {
  const parts: { header: Uint8Array; name: Uint8Array; data: Uint8Array; offset: number }[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = new TextEncoder().encode(entry.name);
    const crc = crc32(entry.data);
    const header = new Uint8Array(30);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x04034b50, true); // local file header signature
    view.setUint16(4, 20, true);         // version needed
    view.setUint16(6, 0, true);          // flags
    view.setUint16(8, 0, true);          // compression: stored
    view.setUint16(10, 0, true);         // mod time
    view.setUint16(12, 0, true);         // mod date
    view.setUint32(14, crc, true);       // crc32
    view.setUint32(18, entry.data.length, true); // compressed size
    view.setUint32(22, entry.data.length, true); // uncompressed size
    view.setUint16(26, name.length, true);       // file name length
    view.setUint16(28, 0, true);         // extra field length
    parts.push({ header, name, data: entry.data, offset });
    offset += 30 + name.length + entry.data.length;
  }

  // Central directory
  const cdParts: Uint8Array[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const name = new TextEncoder().encode(entry.name);
    const crc = crc32(entry.data);
    const cd = new Uint8Array(46);
    const cdv = new DataView(cd.buffer);
    cdv.setUint32(0, 0x02014b50, true);  // central dir signature
    cdv.setUint16(4, 20, true);          // version made by
    cdv.setUint16(6, 20, true);          // version needed
    cdv.setUint16(8, 0, true);           // flags
    cdv.setUint16(10, 0, true);          // compression
    cdv.setUint16(12, 0, true);          // mod time
    cdv.setUint16(14, 0, true);          // mod date
    cdv.setUint32(16, crc, true);        // crc32
    cdv.setUint32(20, entry.data.length, true);
    cdv.setUint32(24, entry.data.length, true);
    cdv.setUint16(28, name.length, true);
    cdv.setUint16(30, 0, true);          // extra length
    cdv.setUint16(32, 0, true);          // comment length
    cdv.setUint16(34, 0, true);          // disk start
    cdv.setUint16(36, 0, true);          // internal attrs
    cdv.setUint32(38, 0, true);          // external attrs
    cdv.setUint32(42, parts[i].offset, true); // local header offset
    cdParts.push(cd, name);
  }

  const cdSize = cdParts.reduce((s, p) => s + p.length, 0);

  // End of central directory
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);

  const allParts: Uint8Array[] = [];
  for (const p of parts) {
    allParts.push(p.header, p.name, p.data);
  }
  allParts.push(...cdParts, eocd);

  const total = allParts.reduce((s, p) => s + p.length, 0);
  const result = new Uint8Array(total);
  let pos = 0;
  for (const p of allParts) {
    result.set(p, pos);
    pos += p.length;
  }
  return result;
}

function crc32(data: Uint8Array): number {
  let crc = ~0;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (~crc) >>> 0;
}
