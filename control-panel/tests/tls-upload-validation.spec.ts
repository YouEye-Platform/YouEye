import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { validateUploadedCertificate } from '../src/lib/acme/upload-validation';

test('uploaded material proves key, hostname, chain and validity before activation', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'youeye-tls-upload-'));
  const file = (name: string) => path.join(directory, name);
  const openssl = (...args: string[]) => execFileSync('openssl', args, { stdio: 'ignore' });
  const read = (name: string) => readFileSync(file(name), 'utf8');
  try {
    for (const name of ['root', 'other']) openssl('req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256',
      '-nodes', '-days', '30', '-subj', `/CN=${name}`, '-addext', 'basicConstraints=critical,CA:TRUE',
      '-keyout', file(`${name}.key`), '-out', file(`${name}.crt`));
    openssl('req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
      '-subj', '/CN=server.example.test', '-keyout', file('leaf.key'), '-out', file('leaf.csr'));
    writeFileSync(file('leaf.ext'), 'basicConstraints=critical,CA:FALSE\nsubjectAltName=DNS:server.example.test,DNS:*.server.example.test\n');
    openssl('x509', '-req', '-in', file('leaf.csr'), '-CA', file('root.crt'), '-CAkey', file('root.key'),
      '-CAcreateserial', '-days', '30', '-extfile', file('leaf.ext'), '-out', file('leaf.crt'));
    const input = { certificate: read('leaf.crt') + read('root.crt'), privateKey: read('leaf.key'),
      domains: ['server.example.test', '*.server.example.test'] };
    const valid = validateUploadedCertificate(input);
    assert.deepEqual(valid.domains, input.domains);
    assert.ok(Date.parse(valid.expiresAt) > Date.now());
    assert.throws(() => validateUploadedCertificate({ ...input, privateKey: read('other.key') }), /do not match/);
    assert.throws(() => validateUploadedCertificate({ ...input, domains: ['wrong.example.test'] }), /does not cover/);
    assert.throws(() => validateUploadedCertificate({ ...input, certificate: read('leaf.crt') + read('other.crt') }), /issuer or signature/);
    assert.throws(() => validateUploadedCertificate({ ...input, now: Date.now() + 40 * 86400_000 }), /expired/);
    assert.throws(() => validateUploadedCertificate({ ...input, now: Date.now() - 86400_000 }), /not yet valid/);
    assert.throws(() => validateUploadedCertificate({ ...input, certificate: input.certificate + '<script>' }), /Invalid certificate chain/);
    assert.throws(() => validateUploadedCertificate({ ...input, domains: [{ untrusted: 'object' }] }), /DNS names/);
    assert.throws(() => validateUploadedCertificate({ ...input, privateKey: 'x'.repeat(32 * 1024 + 1) }), /too large/);
    assert.throws(() => validateUploadedCertificate({ ...input, certificate: 'x'.repeat(192 * 1024 + 1) }), /too large/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
