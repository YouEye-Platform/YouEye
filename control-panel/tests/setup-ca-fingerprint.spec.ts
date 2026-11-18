// Run: node --import tsx --test tests/setup-ca-fingerprint.spec.ts
// The setup surface shows the root CA's SHA-256 (of its DER) in the format the console shows.
import assert from 'node:assert/strict';
import { createHash, X509Certificate } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { NextRequest } from 'next/server';
import { certificateFingerprint } from '../src/lib/caddy/root-ca';

test('the CA fingerprint is the SHA-256 of the DER as colon-separated uppercase hex', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'youeye-ca-fingerprint-'));
  try {
    const crt = path.join(dir, 'root.crt');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
      '-keyout', path.join(dir, 'root.key'), '-out', crt, '-subj', '/CN=YouEye Local Authority', '-days', '1'], { stdio: 'ignore' });
    const pem = readFileSync(crt, 'utf8');
    const der = new X509Certificate(pem).raw;
    const expected = createHash('sha256').update(der).digest('hex').toUpperCase().match(/../g)!.join(':');
    assert.equal(certificateFingerprint(pem), expected);
    assert.match(certificateFingerprint(pem), /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the fingerprint endpoint answers only on the setup surface', async () => {
  const { GET } = await import('../src/app/api/setup/ca-fingerprint/route');
  const response = await GET(new NextRequest('https://box.example.test/api/setup/ca-fingerprint', { headers: { host: 'box.example.test' } }));
  assert.equal(response.status, 404);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('the secure-connection panel shows the fingerprint with the check-it line', () => {
  const panel = readFileSync(new URL('../src/components/setup/SetupSecureConnection.tsx', import.meta.url), 'utf8');
  assert.match(panel, /fetch\('\/api\/setup\/ca-fingerprint'/);
  assert.match(panel, /t\('secureConnectionFingerprint'\)/);
  const en = JSON.parse(readFileSync(new URL('../messages/en.json', import.meta.url), 'utf8'));
  assert.equal(en.setup.secureConnectionFingerprint, "Before trusting it, check that this fingerprint matches the one on the box's screen.");
});
