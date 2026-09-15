// Run: pnpm exec node --import tsx --test tests/youeye-names-security.spec.ts
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { before } from 'node:test';

const testRoot = mkdtempSync(path.join(tmpdir(), 'youeye-names-security-'));
process.env.YOUEYE_NAMES_DATA_DIR = path.join(testRoot, 'state');
process.env.YOUEYE_NAMES_URL = 'https://names.test';
process.env.YOUEYE_NAMES_EXPECTED_SERVICE_ID = 'youeye-names-official';

let identityModule: typeof import('../src/lib/youeye-names/identity');
let certificateModule: typeof import('../src/lib/youeye-names/certificate');
let clientModule: typeof import('../src/lib/youeye-names/client');
let bundleModule: typeof import('../src/lib/youeye-names/bundle');
let stateModule: typeof import('../src/lib/youeye-names/state');
let serviceModule: typeof import('../src/lib/youeye-names/service');

before(async () => {
  identityModule = await import('../src/lib/youeye-names/identity');
  certificateModule = await import('../src/lib/youeye-names/certificate');
  clientModule = await import('../src/lib/youeye-names/client');
  bundleModule = await import('../src/lib/youeye-names/bundle');
  stateModule = await import('../src/lib/youeye-names/state');
  serviceModule = await import('../src/lib/youeye-names/service');
});

function storedIdentity() {
  const pair = crypto.generateKeyPairSync('ed25519');
  const publicDer = pair.publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  const publicKeyRaw = publicDer.subarray(-32).toString('base64url');
  return {
    schema: 1 as const,
    privateKeyPem: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }) as string,
    publicKeyRaw,
    fingerprint: crypto.createHash('sha256').update(Buffer.from(publicKeyRaw, 'base64url')).digest('base64url'),
  };
}

test('identity is created once with protected durable state', async () => {
  const [first, second] = await Promise.all([
    identityModule.getInstallIdentity(),
    identityModule.getInstallIdentity(),
  ]);
  assert.equal(first.fingerprint, second.fingerprint);
  assert.equal(statSync(identityModule.IDENTITY_DATA_DIR).mode & 0o777, 0o700);
  assert.equal(statSync(identityModule.IDENTITY_FILE_PATH).mode & 0o777, 0o600);
  const persisted = JSON.parse(readFileSync(identityModule.IDENTITY_FILE_PATH, 'utf8'));
  assert.equal(persisted.schema, 1);
  assert.equal(persisted.fingerprint, first.fingerprint);
});

test('identity corruption fails closed and is not silently replaced', async () => {
  writeFileSync(identityModule.IDENTITY_FILE_PATH, '{broken-json', { mode: 0o600 });
  identityModule.resetIdentityCache();
  await assert.rejects(
    identityModule.getInstallIdentity(),
    /youeye_names_identity_json_invalid/,
  );
  assert.equal(readFileSync(identityModule.IDENTITY_FILE_PATH, 'utf8'), '{broken-json');

  await identityModule.writeInstallIdentityAtomic(storedIdentity());
  identityModule.resetIdentityCache();
  await identityModule.getInstallIdentity();
});

test('identity validation rejects a mismatched public key and fingerprint', () => {
  const first = storedIdentity();
  const second = storedIdentity();
  assert.throws(
    () => identityModule.validateStoredIdentity({ ...first, publicKeyRaw: second.publicKeyRaw }),
    /key_pair_mismatch/,
  );
  assert.throws(
    () => identityModule.validateStoredIdentity({ ...first, fingerprint: second.fingerprint }),
    /fingerprint_mismatch/,
  );
});

test('service discovery is pinned to v1, exact origin, identity, capabilities and zone', () => {
  const valid = {
    ok: true,
    service: {
      id: 'youeye-names-official', canonicalOrigin: 'https://names.test', managedZone: 'ui.bingo',
      apiVersion: 'v1', environment: 'production',
      capabilities: ['install-signatures', 'lease-lifecycle', 'certificate-lifecycle'],
      certificateTermsVersion: '2026-08-20', privacyNoticeVersion: '2026-08-30',
      privacyPolicyUrl: 'https://names.test/privacy',
    },
  };
  assert.equal(serviceModule.validateNamesServiceDocument(valid, 'https://names.test').managedZone, 'ui.bingo');
  assert.throws(() => serviceModule.validateNamesServiceDocument({ ...valid, service: { ...valid.service, canonicalOrigin: 'https://wrong.test' } }, 'https://names.test'), /origin_mismatch/);
  assert.throws(() => serviceModule.validateNamesServiceDocument({ ...valid, service: { ...valid.service, id: 'other-service' } }, 'https://names.test'), /identity_mismatch/);
  assert.throws(() => serviceModule.validateNamesServiceDocument({ ...valid, service: { ...valid.service, apiVersion: 'v2' } }, 'https://names.test'), /contract_invalid/);
  assert.throws(() => serviceModule.validateNamesServiceDocument({ ...valid, service: { ...valid.service, capabilities: [] } }, 'https://names.test'), /capabilities_missing/);
});

function makeCertificate(name: string, extraSan = '') {
  const directory = mkdtempSync(path.join(testRoot, 'certificate-'));
  const key = path.join(directory, 'key.pem');
  const cert = path.join(directory, 'cert.pem');
  const sans = `DNS:${name},DNS:*.${name}${extraSan}`;
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '30',
    '-subj', `/CN=${name}`, '-addext', `subjectAltName=${sans}`,
    '-keyout', key, '-out', cert,
  ], { stdio: 'ignore' });
  return { keyPem: readFileSync(key, 'utf8'), certPem: readFileSync(cert, 'utf8') };
}

test('certificate validation proves key, exact SANs, fingerprint and dates', () => {
  const fqdn = 'quiet-forest.ui.bingo';
  const material = makeCertificate(fqdn);
  const validated = certificateModule.validateCertificateMaterial({
    certificateChain: material.certPem,
    privateKeyPem: material.keyPem,
    fqdn,
  });
  assert.deepEqual(validated.domains, [fqdn, `*.${fqdn}`]);
  assert.match(validated.fingerprint, /^[a-f0-9]{64}$/);
  assert.match(validated.brokerFingerprint, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(
    validated.brokerFingerprint,
    crypto
      .createHash('sha256')
      .update(material.certPem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/)![0])
      .digest('base64url'),
  );
  assert.notEqual(validated.brokerFingerprint, validated.fingerprint);
  assert.ok(Date.parse(validated.expiresAt) > Date.now());
  assert.equal(
    certificateModule.sameCertificateInstant(
      '2026-11-18T04:23:54Z',
      '2026-11-18T04:23:54.000Z',
    ),
    true,
  );
  assert.equal(
    certificateModule.sameCertificateInstant(
      '2026-11-18T04:23:54Z',
      '2026-11-18T04:23:55Z',
    ),
    false,
  );

  const other = makeCertificate(fqdn);
  assert.throws(
    () => certificateModule.validateCertificateMaterial({
      certificateChain: material.certPem,
      privateKeyPem: other.keyPem,
      fqdn,
    }),
    /key_mismatch/,
  );
  const extra = makeCertificate(fqdn, ',DNS:other.example');
  assert.throws(
    () => certificateModule.validateCertificateMaterial({
      certificateChain: extra.certPem,
      privateKeyPem: extra.keyPem,
      fqdn,
    }),
    /sans_invalid/,
  );
});

test('bundle v3 is service-bound and rejects obsolete bundle shapes', () => {
  const name = 'quiet-forest';
  const fqdn = `${name}.ui.bingo`;
  const material = makeCertificate(fqdn);
  const certificate = certificateModule.validateCertificateMaterial({
    certificateChain: material.certPem,
    privateKeyPem: material.keyPem,
    fqdn,
  });
  const identity = storedIdentity();
  const value = {
    schemaVersion: 3,
    exportedAt: new Date().toISOString(),
    service: {
      id: 'youeye-names-official',
      canonicalOrigin: 'https://names.test',
      apiVersion: 'v1',
      managedZone: 'ui.bingo',
    },
    name,
    fqdn,
    identity,
    tls: { keyPem: material.keyPem, certPem: material.certPem },
    certificate: {
      fingerprint: certificate.fingerprint,
      provider: null,
      issuedAt: certificate.issuedAt,
      expiresAt: certificate.expiresAt,
    },
    consent: { termsVersion: null, certificateTransparencyAcceptedAt: null },
  };
  const parsed = bundleModule.parseNamesBundle(value);
  assert.equal(parsed.schemaVersion, 3);
  assert.equal(parsed.fqdn, fqdn);
  assert.equal(parsed.identity.schema, 1);
  assert.throws(
    () => bundleModule.parseNamesBundle({ ...value, fqdn: 'other.ui.bingo' }),
    /fqdn_invalid/,
  );
  assert.throws(
    () => bundleModule.parseNamesBundle({
      ...value,
      certificate: { ...value.certificate, fingerprint: '0'.repeat(64) },
    }),
    /metadata_mismatch/,
  );
  assert.throws(() => bundleModule.parseNamesBundle({ ...value, schemaVersion: 2 }), /format_invalid/);
  assert.throws(() => bundleModule.parseNamesBundle({
    ...value,
    service: { ...value.service, id: 'untrusted-service' },
  }), /service_mismatch/);
});

test('lifecycle state is strict, atomic and protected', async () => {
  const now = new Date().toISOString();
  await stateModule.writeNamesLifecycleState({
    schemaVersion: 2,
    service: {
      id: 'youeye-names-official', canonicalOrigin: 'https://names.test',
      apiVersion: 'v1', managedZone: 'ui.bingo',
    },
    name: 'quiet-forest',
    fqdn: 'quiet-forest.ui.bingo',
    status: 'healthy',
    provisioning: null,
    termsVersion: '2026-08-21',
    certificateTransparencyAcceptedAt: now,
    certificate: {
      fingerprint: 'a'.repeat(64),
      provider: 'letsencrypt',
      issuedAt: now,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    },
    lastBrokerContactAt: now,
    lastHeartbeatAt: now,
    nextCheckAt: new Date(Date.now() + 3_600_000).toISOString(),
    lastError: null,
  });
  const state = await stateModule.readNamesLifecycleState();
  assert.equal(state?.status, 'healthy');
  assert.equal(statSync(stateModule.NAMES_LIFECYCLE_FILE_PATH).mode & 0o777, 0o600);
});

test('proof-of-work runs in a worker and returns a valid bounded nonce', async () => {
  const challenge = {
    token: 'test-token',
    difficulty: 10,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  const proof = await clientModule.solveProofOfWork(challenge);
  const digest = crypto.createHash('sha256').update(`${proof.token}:${proof.nonce}`).digest();
  assert.equal(digest[0], 0);
  assert.equal(digest[1] >> 6, 0);
});

test('broker registration challenge and signed preview use validated contracts', async () => {
  clientModule.resetBrokerRegistrationCache();
  const originalFetch = globalThis.fetch;
  let registrationCalls = 0;
  let signedCalls = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/v1/service-info')) {
      return Response.json({ ok: true, service: {
        id: 'youeye-names-official', canonicalOrigin: 'https://names.test', managedZone: 'ui.bingo',
        apiVersion: 'v1', environment: 'development',
        capabilities: ['install-signatures', 'lease-lifecycle', 'certificate-lifecycle'],
        certificateTermsVersion: '2026-08-20', privacyNoticeVersion: '2026-08-30',
      } });
    }
    if (url.endsWith('/v1/installs/register')) {
      registrationCalls += 1;
      const request = JSON.parse(String(init?.body)) as { publicKey: string; proof?: unknown };
      const fingerprint = crypto.createHash('sha256').update(Buffer.from(request.publicKey, 'base64url')).digest('base64url');
      if (!request.proof) {
        return Response.json({
          ok: false,
          error: 'proof_of_work_required',
          decision: 'challenge_required',
          requestId: 'register-challenge',
          challenge: { token: 'registration-token', difficulty: 8, expiresAt: new Date(Date.now() + 60_000).toISOString() },
        }, { status: 429 });
      }
      return Response.json({ ok: true, requestId: 'registered', install: { fingerprint } }, { status: 201 });
    }
    if (url.endsWith('/v1/leases/preview')) {
      signedCalls += 1;
      const headers = new Headers(init?.headers);
      assert.match(String(headers.get('x-youeye-signature')), /^[A-Za-z0-9_-]+$/);
      assert.equal(headers.get('x-youeye-service-id'), 'youeye-names-official');
      assert.equal(headers.get('x-youeye-service-origin'), 'https://names.test');
      return Response.json({
        ok: true,
        requestId: 'previewed',
        previews: [{ name: 'quiet-forest', fqdn: 'quiet-forest.ui.bingo', wildcardFqdn: '*.quiet-forest.ui.bingo', available: true }],
        committed: false,
        claimRequired: true,
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  try {
    const previews = await clientModule.previewNames(1);
    assert.equal(previews[0].fqdn, 'quiet-forest.ui.bingo');
    assert.equal(registrationCalls, 2);
    assert.equal(signedCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('registration and exact-name claim use separate bound human-verification challenges', async () => {
  clientModule.resetBrokerRegistrationCache();
  const originalFetch = globalThis.fetch;
  let registered = false;
  let claimSigned = false;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/v1/service-info')) return Response.json({ ok: true, service: {
      id: 'youeye-names-official', canonicalOrigin: 'https://names.test', managedZone: 'ui.bingo',
      apiVersion: 'v1', environment: 'development',
      capabilities: ['install-signatures', 'lease-lifecycle', 'certificate-lifecycle'],
      certificateTermsVersion: '2026-08-20', privacyNoticeVersion: '2026-08-30',
    } });
    if (url.endsWith('/v1/installs/register')) {
      const request = JSON.parse(String(init?.body)) as { publicKey: string; humanVerificationProof?: string };
      const fingerprint = crypto.createHash('sha256').update(Buffer.from(request.publicKey, 'base64url')).digest('base64url');
      if (!registered) assert.equal(request.humanVerificationProof, 'registration-proof-value-123456789');
      registered = true;
      return Response.json({ ok: true, idempotent: true, install: { fingerprint } });
    }
    if (url.endsWith('/v1/human-verification/challenges')) {
      const body = JSON.parse(String(init?.body)) as { purpose: string; publicKey?: string; name?: string; currentIp?: string };
      const fingerprint = body.publicKey
        ? crypto.createHash('sha256').update(Buffer.from(body.publicKey, 'base64url')).digest('base64url')
        : (await identityModule.getInstallIdentity()).fingerprint;
      const headers = new Headers(init?.headers);
      if (body.purpose === 'lease_claim') {
        claimSigned = true;
        assert.equal(headers.get('x-youeye-service-id'), 'youeye-names-official');
        assert.equal(body.name, 'quiet-forest');
        assert.equal(body.currentIp, '192.168.31.10');
      } else {
        assert.equal(headers.get('x-youeye-signature'), null);
      }
      return Response.json({
        ok: true, siteKey: 'site', action: 'youeye_names_enrollment', cData: 'bound-data',
        expiresAt: new Date(Date.now() + 60_000).toISOString(), context: 'c'.repeat(40),
        enrollmentUrl: 'https://names.test/enroll#private-context',
        ...(body.name ? { name: body.name } : {}),
        installFingerprint: fingerprint,
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  try {
    const registration = await clientModule.createHumanVerificationChallenge('install_register');
    assert.equal(registration.purpose, 'install_register');
    await clientModule.registerInstall('registration-proof-value-123456789');
    const claim = await clientModule.createHumanVerificationChallenge('lease_claim', { name: 'quiet-forest', currentIp: '192.168.31.10' });
    assert.equal(claim.name, 'quiet-forest');
    assert.equal('currentIp' in claim, false);
    assert.equal(claimSigned, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('popup handoff source enforces exact window/origin/shape and keeps proofs memory-only', () => {
  const source = readFileSync(path.join(process.cwd(), 'src/lib/youeye-names/popup.ts'), 'utf8');
  assert.match(source, /event\.source !== popup \|\| event\.origin !== serviceOrigin/);
  assert.match(source, /exactKeys\(message/);
  assert.match(source, /popup\.postMessage\([^]*serviceOrigin/);
  assert.doesNotMatch(source, /postMessage\([^\n]+['"]\*['"]/);
  assert.doesNotMatch(source, /localStorage|sessionStorage|console\./);
});

test('setup persists resumable key/CSR state but never a verification proof', () => {
  const setup = readFileSync(path.join(process.cwd(), 'src/app/api/setup/run/route.ts'), 'utf8');
  const state = readFileSync(path.join(process.cwd(), 'src/lib/youeye-names/state.ts'), 'utf8');
  const maintenance = readFileSync(path.join(process.cwd(), 'src/lib/youeye-names/maintenance.ts'), 'utf8');
  const enrollment = readFileSync(path.join(process.cwd(), 'src/app/api/tls/youeye-names/enrollment/route.ts'), 'utf8');
  assert.match(setup, /priorProvisioning[\s\S]*privateKeyPem[\s\S]*csrPem/);
  assert.match(setup, /10 \* 60_000/);
  assert.match(maintenance, /resumeProvisioning[\s\S]*requestCertificate[\s\S]*waitForCertificate/);
  assert.doesNotMatch(state, /humanVerificationProof|yen_human_verification_proof/);
  assert.match(enrollment, /session\?\.isAdmin/);
  assert.match(enrollment, /verifyCSRFToken/);
  assert.match(enrollment, /spineClient\.getMetrics\(\)/);
});

test('broker contract drift is rejected without leaking response content', async () => {
  clientModule.resetBrokerRegistrationCache();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/v1/service-info')) {
      return Response.json({ ok: true, service: {
        id: 'youeye-names-official', canonicalOrigin: 'https://names.test', managedZone: 'ui.bingo',
        apiVersion: 'v1', environment: 'development',
        capabilities: ['install-signatures', 'lease-lifecycle', 'certificate-lifecycle'],
        certificateTermsVersion: '2026-08-20', privacyNoticeVersion: '2026-08-30',
      } });
    }
    if (url.endsWith('/v1/installs/register')) {
      const request = JSON.parse(String(init?.body)) as { publicKey: string };
      const fingerprint = crypto.createHash('sha256').update(Buffer.from(request.publicKey, 'base64url')).digest('base64url');
      return Response.json({ ok: true, install: { fingerprint } });
    }
    return Response.json({ ok: true, previews: 'not-an-array' });
  };
  try {
    await assert.rejects(clientModule.previewNames(1), (error: unknown) => {
      assert.ok(error instanceof clientModule.NamesBrokerError);
      assert.equal(error.code, 'broker_response_contract_invalid');
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
