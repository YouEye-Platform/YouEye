// Run: node --import tsx --test tests/names-provision.spec.ts
// The YouEye Names job (Plan 8 items 11, 15) against a fake broker: start twice,
// restart at every stage, continue/change name, timeouts and the wizard status.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after, before, beforeEach } from 'node:test';

const testRoot = mkdtempSync(path.join(tmpdir(), 'youeye-names-provision-'));
process.env.YOUEYE_NAMES_DATA_DIR = path.join(testRoot, 'state');
process.env.YOUEYE_NAMES_URL = 'https://names.test';
process.env.YOUEYE_NAMES_EXPECTED_SERVICE_ID = 'youeye-names-official';
process.env.YOUEYE_APP_UPDATE_JOURNAL_DIR = path.join(testRoot, 'app-updates');
after(() => rmSync(testRoot, { recursive: true, force: true }));

let provision: typeof import('../src/lib/youeye-names/provision');
let state: typeof import('../src/lib/youeye-names/state');
let client: typeof import('../src/lib/youeye-names/client');

before(async () => {
  provision = await import('../src/lib/youeye-names/provision');
  state = await import('../src/lib/youeye-names/state');
  client = await import('../src/lib/youeye-names/client');
});

const NAME = 'calm-river';
const FQDN = 'calm-river.ui.bingo';
const KEY = '-----BEGIN PRIVATE KEY-----\n' + 'k'.repeat(80) + '\n-----END PRIVATE KEY-----';
const CSR = '-----BEGIN CERTIFICATE REQUEST-----\n' + 'c'.repeat(160) + '\n-----END CERTIFICATE REQUEST-----';
const CHAIN = '-----BEGIN CERTIFICATE-----\n' + 'x'.repeat(120) + '\n-----END CERTIFICATE-----';
const EXPIRES = '2027-02-15T00:00:00.000Z';
const service = {
  id: 'youeye-names-official', canonicalOrigin: 'https://names.test', apiVersion: 'v1' as const, managedZone: 'ui.bingo',
  url: 'https://names.test', environment: 'development', capabilities: ['verified-setup-v1'],
  certificateTermsVersion: '2026-08-20', privacyNoticeVersion: '2026-08-30',
};

type Calls = Record<string, unknown[][]>;
function fakeBroker(options: { readyAfterPolls?: number; neverReady?: boolean; issued?: boolean; claimError?: unknown; onPoll?: () => Promise<void> } = {}) {
  const calls: Calls = {};
  const record = (name: string, ...args: unknown[]) => { (calls[name] ??= []).push(args); };
  let polls = 0;
  let issued = options.issued ?? false;
  let stored: import('../src/lib/acme/storage').StoredCert | null = null;
  const io: import('../src/lib/youeye-names/provision').NamesJobIO = {
    currentIp: async () => '192.168.1.50',
    terms: async () => ({ version: '2026-08-20' }),
    service: async () => service as never,
    registerVerifiedSetup: async (session) => { record('register', session); },
    claim: async (name, ip, proof, session) => {
      record('claim', name, ip, proof, session);
      if (options.claimError) throw options.claimError;
    },
    getLease: async (name) => { record('getLease', name); },
    generateCsr: async (fqdn) => { record('generateCsr', fqdn); return { keyPem: KEY, csrPem: CSR }; },
    requestCertificate: async (name, csrPem, terms) => {
      record('request', name, csrPem, terms);
      // Like the broker: once a certificate exists, a new request is a renewal outside its window.
      if (issued) throw new client.NamesBrokerError({ status: 409, code: 'certificate_renewal_not_due' });
    },
    currentCertificate: async (name) => {
      record('poll', name);
      polls++;
      await options.onPoll?.();
      if (options.neverReady || polls <= (options.readyAfterPolls ?? 0)) return null;
      issued = true;
      return { certificateChain: CHAIN, fingerprint: 'broker-fp', provider: 'letsencrypt', issuedAt: '2026-11-17T00:00:00.000Z', expiresAt: EXPIRES } as never;
    },
    validate: (input) => {
      record('validate', input.privateKeyPem, input.fqdn);
      return { certificateChain: CHAIN, fingerprint: 'a'.repeat(64), brokerFingerprint: 'broker-fp', issuedAt: '2026-11-17T00:00:00.000Z', expiresAt: EXPIRES, domains: [FQDN, `*.${FQDN}`] };
    },
    loadIntoCaddy: async (cert, key, domains) => { record('caddy', key, domains); },
    store: async (cert) => { record('store', cert.keyPem); stored = cert; },
    storedCertificate: async () => stored,
    heartbeat: async (name) => { record('heartbeat', name); },
    delay: async () => undefined,
    exclusive: (work) => work(),
  };
  return { io, calls, count: (name: string) => calls[name]?.length ?? 0 };
}

const startInput = {
  name: NAME, fqdn: FQDN, termsVersion: '2026-08-20', ctAccepted: true,
  verifiedSetupSession: 'v'.repeat(80),
};

beforeEach(async () => {
  rmSync(path.join(testRoot, 'state'), { recursive: true, force: true });
});

function provisioningState(stage: 'lease_claimed' | 'certificate_requested' | 'certificate_waiting' | 'certificate_received' | 'activating', withKey: boolean) {
  const at = '2026-11-17T10:00:00.000Z';
  return {
    schemaVersion: 1 as const,
    service: { id: service.id, canonicalOrigin: service.canonicalOrigin, apiVersion: 'v1' as const, managedZone: 'ui.bingo' },
    name: NAME, fqdn: FQDN, status: 'provisioning' as const,
    provisioning: { stage, startedAt: at, lastAttemptAt: at, brokerRequestId: null, privateKeyPem: withKey ? KEY : null, csrPem: withKey ? CSR : null },
    termsVersion: '2026-08-20', certificateTransparencyAcceptedAt: at, certificate: null,
    lastBrokerContactAt: at, lastHeartbeatAt: null, nextCheckAt: at, lastError: null,
  };
}

test('start claims and requests once; the background job installs the certificate', async () => {
  const broker = fakeBroker({ readyAfterPolls: 2 });
  const status = await provision.startNamesJob(startInput, broker.io);
  assert.equal(status.stage, 'certificate_waiting');
  assert.equal(broker.count('register'), 1);
  assert.equal(broker.count('claim'), 1);
  assert.equal(broker.count('request'), 1);
  const saved = await state.readNamesLifecycleState();
  assert.equal(saved?.provisioning?.privateKeyPem, KEY);
  assert.equal(saved?.provisioning?.csrPem, CSR);
  // Persisted state never holds the verification proof or session.
  assert.doesNotMatch(readFileSync(state.NAMES_LIFECYCLE_FILE_PATH, 'utf8'), /vvvvvvvv/);

  await provision.followNamesJob(broker.io);
  const healthy = await state.readNamesLifecycleState();
  assert.equal(healthy?.status, 'healthy');
  assert.equal(healthy?.provisioning, null);
  assert.equal(healthy?.certificate?.expiresAt, EXPIRES);
  assert.equal(broker.count('caddy'), 1);
  assert.equal(broker.count('store'), 1);
  assert.equal(broker.count('heartbeat'), 1);
  // The job repeats the same request (idempotent at the broker), never a new CSR.
  assert.equal(broker.count('generateCsr'), 1);
  assert.ok(broker.calls.request.every(([, csr]) => csr === CSR));
  assert.equal((await provision.namesJobStatus()).stage, 'ready');
});

test('starting the same name twice never claims or requests again', async () => {
  const broker = fakeBroker({ neverReady: true });
  await provision.startNamesJob(startInput, broker.io);
  const again = await provision.startNamesJob({ ...startInput, verifiedSetupSession: 'w'.repeat(80) }, broker.io);
  assert.equal(again.name, NAME);
  assert.equal(again.stage, 'certificate_waiting');
  assert.equal(broker.count('claim'), 1);
  assert.equal(broker.count('register'), 1);
  assert.equal(broker.count('request'), 1);
});

test('a claim the install already holds is resumed, not refused', async () => {
  const broker = fakeBroker({ neverReady: true, claimError: new client.NamesBrokerError({ status: 409, code: 'install_already_has_active_lease' }) });
  await provision.startNamesJob(startInput, broker.io);
  assert.equal(broker.count('getLease'), 1);
  assert.equal((await state.readNamesLifecycleState())?.status, 'provisioning');
});

test('start refuses missing terms, verification and a public address before any broker effect', async () => {
  for (const [input, code] of [
    [{ ...startInput, ctAccepted: false }, 'names_terms_required'],
    [{ ...startInput, termsVersion: 'old' }, 'names_terms_required'],
    [{ ...startInput, verifiedSetupSession: undefined }, 'names_verification_required'],
    [{ ...startInput, humanVerificationProof: 'p'.repeat(40) }, 'names_verification_invalid'],
    [{ ...startInput, fqdn: 'other.ui.bingo' }, 'names_name_invalid'],
  ] as const) {
    const broker = fakeBroker();
    await assert.rejects(provision.startNamesJob(input as never, broker.io), (error: Error & { code?: string }) => error.code === code);
    assert.equal(broker.count('claim'), 0, code);
    assert.equal(await state.readNamesLifecycleState(), null);
  }
  const broker = fakeBroker();
  broker.io.currentIp = async () => '8.8.8.8';
  await assert.rejects(provision.startNamesJob(startInput, broker.io), { code: 'names_private_address_unavailable' });
  assert.equal(broker.count('claim'), 0);
});

for (const [stage, withKey, issuedAtBroker] of [
  ['lease_claimed', false, false],
  ['certificate_requested', false, false],
  ['certificate_requested', true, false],
  ['certificate_waiting', true, false],
  ['certificate_waiting', true, true],
  ['certificate_received', true, true],
  ['activating', true, true],
] as const) {
  test(`a restart at ${stage}${withKey ? '' : ' (before the key was saved)'}${issuedAtBroker ? ' (certificate issued)' : ''} resumes with the same key and request`, async () => {
    await state.writeNamesLifecycleState(provisioningState(stage, withKey));
    const broker = fakeBroker({ readyAfterPolls: issuedAtBroker ? 0 : 1, issued: issuedAtBroker });
    await provision.followNamesJob(broker.io);
    const after = await state.readNamesLifecycleState();
    assert.equal(after?.status, 'healthy');
    assert.equal(broker.count('claim'), 0, 'never claims again');
    assert.equal(broker.count('generateCsr'), withKey ? 0 : 1, 'a saved key and CSR are reused');
    // An issued certificate is fetched, never requested again.
    assert.equal(broker.count('request'), issuedAtBroker ? 0 : 1);
    if (!issuedAtBroker) assert.equal(broker.calls.request[0][1], CSR);
    assert.deepEqual(broker.calls.caddy[0], [KEY, [FQDN, `*.${FQDN}`]]);
  });
}

test('concurrent followers and provisioning share one job', async () => {
  await state.writeNamesLifecycleState(provisioningState('certificate_waiting', true));
  const broker = fakeBroker({ readyAfterPolls: 3 });
  await Promise.all([
    provision.followNamesJob(broker.io),
    provision.awaitNamesCertificate(NAME, FQDN, broker.io),
    provision.followNamesJob(broker.io),
  ]);
  assert.equal(broker.count('request'), 1);
  assert.equal(broker.count('store'), 1);
  // Activation reloads the stored certificate, and repeating it is harmless.
  await provision.activateNamesCertificate(FQDN, broker.io);
  await provision.activateNamesCertificate(FQDN, broker.io);
  assert.equal(broker.count('caddy'), 3);
});

test('provisioning never claims a name the job did not start', async () => {
  const broker = fakeBroker();
  await assert.rejects(provision.awaitNamesCertificate(NAME, FQDN, broker.io), { code: 'names_job_missing' });
  await state.writeNamesLifecycleState(provisioningState('certificate_waiting', true));
  await assert.rejects(provision.awaitNamesCertificate('other', 'other.ui.bingo', broker.io), { code: 'names_job_missing' });
  assert.equal(broker.count('claim'), 0);
  assert.equal(broker.count('request'), 0);
  await assert.rejects(provision.activateNamesCertificate(FQDN, broker.io), { code: 'names_certificate_missing' });
});

test('a slow certificate stays resumable and the wizard sees why', async () => {
  await state.writeNamesLifecycleState(provisioningState('certificate_waiting', true));
  const broker = fakeBroker({ neverReady: true });
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => (now += 61_000);
  try {
    await assert.rejects(provision.awaitNamesCertificate(NAME, FQDN, broker.io), { code: 'names_certificate_timeout' });
  } finally {
    Date.now = realNow;
  }
  const saved = await state.readNamesLifecycleState();
  assert.equal(saved?.status, 'provisioning');
  assert.equal(saved?.provisioning?.privateKeyPem, KEY);
  assert.equal(saved?.lastError?.code, 'names_certificate_timeout');
  const status = await provision.namesJobStatus();
  assert.equal(status.stage, 'certificate_waiting');
  assert.match(status.error ?? '', /taking longer than usual/);
  // The retry resumes the same request and finishes.
  await provision.followNamesJob(fakeBroker().io);
  assert.equal((await state.readNamesLifecycleState())?.status, 'healthy');
  assert.equal((await provision.namesJobStatus()).error, null);
});

test('choose a different name: a held name is refused until released, then the new one starts', async () => {
  const broker = fakeBroker({ neverReady: true });
  await provision.startNamesJob(startInput, broker.io);
  await assert.rejects(
    provision.startNamesJob({ ...startInput, name: 'quiet-wood', fqdn: 'quiet-wood.ui.bingo' }, broker.io),
    { code: 'names_lease_held' },
  );
  // The release route marks it released and drops the resumable key and CSR.
  await state.updateNamesLifecycleState((current) => ({ ...current, status: 'released', provisioning: null }));
  assert.equal((await provision.namesJobStatus()).stage, 'none');
  await provision.startNamesJob({ ...startInput, name: 'quiet-wood', fqdn: 'quiet-wood.ui.bingo' }, broker.io);
  const saved = await state.readNamesLifecycleState();
  assert.equal(saved?.name, 'quiet-wood');
  assert.equal(saved?.status, 'provisioning');
});

test('a release during the certificate wait stops the job without bringing the name back', async () => {
  await state.writeNamesLifecycleState(provisioningState('certificate_waiting', true));
  const broker = fakeBroker({
    neverReady: true,
    onPoll: async () => { await state.updateNamesLifecycleState((current) => ({ ...current, status: 'released', provisioning: null })); },
  });
  await provision.followNamesJob(broker.io);
  const saved = await state.readNamesLifecycleState();
  assert.equal(saved?.status, 'released');
  assert.equal(saved?.lastError, null);
  assert.equal(broker.count('caddy'), 0);
  // A late failure record never revives a released name either.
  await provision.markNamesFailure(new Error('late'));
  assert.equal((await state.readNamesLifecycleState())?.status, 'released');
});

test('the wizard status exposes only name, stage and a plain error', async () => {
  assert.deepEqual(await provision.namesJobStatus(), { name: null, fqdn: null, stage: 'none', running: false, error: null });
  await state.writeNamesLifecycleState({ ...provisioningState('certificate_waiting', true), lastError: { code: 'request_cooldown', requestId: 'req-1', at: '2026-11-17T10:00:00.000Z', retryAfterSeconds: 60 } });
  const status = await provision.namesJobStatus();
  assert.deepEqual(Object.keys(status).sort(), ['error', 'fqdn', 'name', 'running', 'stage']);
  assert.match(status.error!, /asking this device to wait.*req-1/);
  assert.doesNotMatch(JSON.stringify(status), /PRIVATE KEY|CERTIFICATE REQUEST/);
});

test('Names errors are logged with their broker code', () => {
  assert.equal(client.namesLogReason(new client.NamesBrokerError({ status: 502, code: 'broker_setup_binding_mismatch' })), 'broker_setup_binding_mismatch');
  assert.equal(client.namesLogReason(new client.NamesBrokerError({ status: 429, code: 'request_cooldown', requestId: 'r1' })), 'request_cooldown (request r1)');
  assert.equal(client.namesLogReason(new Error('verified_setup_origin_invalid\nstack')), 'verified_setup_origin_invalid');
  const preview = readFileSync(path.join(process.cwd(), 'src/app/api/tls/youeye-names/preview/route.ts'), 'utf8');
  assert.match(preview, /console\.error\('\[TLS\/YouEyeNames\] preview failed:', namesLogReason\(error\)\)/);
});

test('two concurrent starts claim once and keep one key and CSR', async () => {
  const broker = fakeBroker({ readyAfterPolls: 1000 });
  let keys = 0;
  const generateCsr = broker.io.generateCsr;
  broker.io.generateCsr = async (fqdn) => {
    const generated = await generateCsr(fqdn);
    keys++;
    return { keyPem: generated.keyPem.replace('kkkk', `k${keys}kk`), csrPem: generated.csrPem.replace('cccc', `c${keys}cc`) };
  };
  // Slow the broker so both requests are in flight together.
  const claim = broker.io.claim;
  broker.io.claim = async (...args) => { await new Promise((resolve) => setTimeout(resolve, 20)); return claim(...args); };
  const [first, second] = await Promise.all([
    provision.startNamesJob(startInput, broker.io),
    provision.startNamesJob(startInput, broker.io),
  ]);
  assert.equal(broker.count('claim'), 1);
  assert.equal(broker.count('generateCsr'), 1);
  assert.equal(broker.count('request'), 1);
  assert.equal(first.stage, 'certificate_waiting');
  assert.equal(second.stage, 'certificate_waiting');
  const saved = await state.readNamesLifecycleState();
  assert.match(saved!.provisioning!.privateKeyPem!, /k1kk/);
  assert.equal(broker.calls.request[0][1], saved!.provisioning!.csrPem);
});

test('a failed certificate request after the claim is followed at once', async () => {
  const broker = fakeBroker();
  broker.io.requestCertificate = async () => { throw new client.NamesBrokerError({ status: 503, code: 'certificate_request_failed' }); };
  await assert.rejects(provision.startNamesJob(startInput, broker.io));
  assert.equal((await state.readNamesLifecycleState())?.status, 'provisioning');
  broker.io.requestCertificate = async (name, csrPem, terms) => { (broker.calls.request ??= []).push([name, csrPem, terms]); };
  await provision.followClaimedNamesJob(broker.io);
  assert.equal((await state.readNamesLifecycleState())?.status, 'healthy');
  assert.equal(broker.count('claim'), 1, 'the follower never claims again');
});

test('nothing is followed when the start failed before any claim', async () => {
  const broker = fakeBroker();
  await assert.rejects(provision.startNamesJob({ ...startInput, ctAccepted: false }, broker.io));
  await provision.followClaimedNamesJob(broker.io);
  assert.equal(broker.count('poll'), 0);
  assert.equal(await state.readNamesLifecycleState(), null);
});
