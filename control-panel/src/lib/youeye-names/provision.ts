/**
 * The YouEye Names job: claim a name, request its certificate and install it.
 *
 * Setup starts it right after the human check (`POST /api/setup/names/start`),
 * so the certificate is issued while the owner designs the title. The job then
 * continues in the background; provisioning only awaits it and activates the
 * stored certificate. Every stage is written to lifecycle.json, and a restart
 * resumes with the same key, CSR and request.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { tlsStorage, type StoredCert } from '@/lib/acme/storage';
import * as caddy from '@/lib/caddy/client';
import { withCaddyMutation } from '@/lib/caddy/serial';
import { withIndependentCopyExclusion } from '@/lib/market/update-admission';
import { spineClient } from '@/lib/spine/client';
import {
  applyBundleIdentity,
  bundleCertStillValid,
  consumeStagedBundle,
  getStagedBundle,
} from './bundle';
import { sameCertificateInstant, validateCertificateMaterial, type ValidatedCertificate } from './certificate';
import {
  claimName,
  getCertificateTerms,
  getCurrentCertificate,
  getLease,
  heartbeat,
  NamesBrokerError,
  namesErrorMessage,
  registerVerifiedSetup,
  requestCertificate,
  updateIp,
  type CurrentCertificate,
  type HeartbeatInput,
} from './client';
import { generateCsr } from './csr';
import { validateStoredIdentity } from './identity';
import { privateNamesAddress } from './setup-request';
import { discoverNamesService, namesServiceBinding, validateManagedName, type NamesService } from './service';
import {
  readNamesLifecycleState,
  updateNamesLifecycleState,
  writeNamesLifecycleState,
  type NamesLifecycleState,
} from './state';

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** The broker's DNS propagation policy can take six minutes before CA work starts. */
const CERTIFICATE_WAIT_MS = 10 * 60_000;
const NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

type ProvisioningStage = NonNullable<NamesLifecycleState['provisioning']>['stage'];

/** Everything the job does outside lifecycle.json; tests replace it with a fake broker. */
export interface NamesJobIO {
  currentIp(): Promise<string>;
  terms(): Promise<{ version: string }>;
  service(): Promise<NamesService>;
  registerVerifiedSetup(session: string): Promise<void>;
  claim(name: string, ip: string, proof?: string, session?: string): Promise<void>;
  getLease(name: string): Promise<void>;
  generateCsr(fqdn: string): Promise<{ keyPem: string; csrPem: string }>;
  requestCertificate(name: string, csrPem: string, termsVersion: string): Promise<void>;
  currentCertificate(name: string): Promise<CurrentCertificate | null>;
  validate(input: { certificateChain: string; privateKeyPem: string; fqdn: string }): ValidatedCertificate;
  loadIntoCaddy(certPem: string, keyPem: string, domains: string[]): Promise<void>;
  store(cert: StoredCert): Promise<void>;
  storedCertificate(): Promise<StoredCert | null>;
  heartbeat(name: string, input: HeartbeatInput): Promise<void>;
  delay(ms: number): Promise<void>;
  exclusive<T>(work: () => Promise<T>): Promise<T>;
}

export const defaultNamesJobIO: NamesJobIO = {
  currentIp: async () => (await spineClient.getMetrics()).primary_ip,
  terms: () => getCertificateTerms(),
  service: () => discoverNamesService(),
  registerVerifiedSetup: (session) => registerVerifiedSetup(session),
  claim: async (name, ip, proof, session) => { await claimName(name, ip, undefined, proof, session); },
  getLease: async (name) => { await getLease(name); },
  generateCsr: (fqdn) => generateCsr(fqdn),
  requestCertificate: async (name, csrPem, termsVersion) => { await requestCertificate(name, csrPem, termsVersion, true); },
  currentCertificate: (name) => getCurrentCertificate(name),
  validate: (input) => validateCertificateMaterial(input),
  loadIntoCaddy: (certPem, keyPem, domains) => caddy.loadExternalCert(certPem, keyPem, domains),
  store: (cert) => tlsStorage.storeCert(cert),
  storedCertificate: () => tlsStorage.getCert(),
  heartbeat: async (name, input) => { await heartbeat(name, input); },
  delay: (ms) => sleep(ms),
  exclusive: (work) => withIndependentCopyExclusion(work),
};

/** An expected job condition with a plain message for the wizard. */
export class NamesJobError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) {
    super(message);
    this.name = 'NamesJobError';
  }
}

const JOB_MESSAGES: Record<string, string> = {
  names_certificate_timeout: 'Your YouEye Names certificate is taking longer than usual. It may still arrive shortly; retry this step in a few minutes.',
  names_job_missing: 'This YouEye Names address was not claimed yet. Go back to the address step and verify again.',
  youeye_names_provisioning_service_mismatch: 'The YouEye Names service changed while your certificate was being issued. Choose a different name.',
  youeye_names_certificate_metadata_mismatch: 'YouEye Names returned inconsistent certificate metadata. Nothing was installed.',
};

type Registry = { follow: Promise<void> | null; startTail?: Promise<void> };
const registry = (globalThis as typeof globalThis & { __youeyeNamesJob?: Registry });
const job: Registry = registry.__youeyeNamesJob ??= { follow: null };

/** One `startNamesJob` at a time in this process (two browser tabs, a double click): one claim, one key and CSR. */
function serialStart<T>(work: () => Promise<T>): Promise<T> {
  const run = (job.startTail ?? Promise.resolve()).then(work);
  job.startTail = run.then(() => undefined, () => undefined);
  return run;
}

/** Record a failure; a provisioning lease stays `provisioning`, never released. */
export async function markNamesFailure(error: unknown): Promise<void> {
  const brokerError = error instanceof NamesBrokerError ? error : null;
  const code = brokerError?.code
    || (error instanceof NamesJobError ? error.code : error instanceof Error ? error.message.slice(0, 256) : 'maintenance_failed');
  await updateNamesLifecycleState((state) => state.status === 'released' ? state : ({
    ...state,
    status: state.provisioning ? 'provisioning' : 'attention',
    nextCheckAt: new Date(
      Date.now() + Math.max(15 * 60_000, (brokerError?.retryAfterSeconds || 0) * 1000),
    ).toISOString(),
    lastError: {
      code: code || 'maintenance_failed',
      requestId: brokerError?.requestId || null,
      retryAfterSeconds: brokerError?.retryAfterSeconds || null,
      at: new Date().toISOString(),
    },
  }));
}

/** Advance one provisioning stage, refusing if the lease was released or replaced meanwhile. */
async function advance(
  name: string,
  stage: ProvisioningStage,
  extra: Partial<NonNullable<NamesLifecycleState['provisioning']>> = {},
): Promise<NamesLifecycleState> {
  let cancelled = false;
  const next = await updateNamesLifecycleState((state) => {
    if (state.status !== 'provisioning' || state.name !== name || !state.provisioning) {
      cancelled = true;
      return state;
    }
    return {
      ...state,
      provisioning: { ...state.provisioning, ...extra, stage, lastAttemptAt: new Date().toISOString() },
    };
  });
  if (!next || cancelled) throw new NamesJobError('names_job_cancelled', 'The YouEye Names address was released.');
  return next;
}

export interface NamesStartInput {
  name: string;
  fqdn: string;
  termsVersion?: unknown;
  ctAccepted?: unknown;
  humanVerificationProof?: unknown;
  verifiedSetupSession?: unknown;
}

export type NamesJobStage = 'none' | ProvisioningStage | 'ready' | 'attention';
export interface NamesJobStatus {
  name: string | null;
  fqdn: string | null;
  stage: NamesJobStage;
  /** A background step is running in this Control Panel right now. */
  running: boolean;
  error: string | null;
}

function errorMessage(code: string, requestId: string | null): string {
  if (JOB_MESSAGES[code]) return JOB_MESSAGES[code];
  return namesErrorMessage(new NamesBrokerError({ status: 409, code, requestId: requestId ?? undefined }));
}

export function namesJobStatusOf(state: NamesLifecycleState | null): NamesJobStatus {
  if (!state || state.status === 'released') {
    return { name: null, fqdn: null, stage: 'none', running: false, error: null };
  }
  const stage: NamesJobStage = state.status === 'provisioning'
    ? state.provisioning?.stage ?? 'lease_claimed'
    : state.status === 'attention' ? 'attention' : 'ready';
  return {
    name: state.name,
    fqdn: state.fqdn,
    stage,
    running: state.status === 'provisioning' && job.follow !== null,
    error: state.lastError ? errorMessage(state.lastError.code, state.lastError.requestId) : null,
  };
}

export async function namesJobStatus(): Promise<NamesJobStatus> {
  return namesJobStatusOf(await readNamesLifecycleState());
}

/** Generate (or reuse) the key and CSR, then request the certificate. */
async function requestWithCsr(state: NamesLifecycleState, io: NamesJobIO): Promise<NamesLifecycleState> {
  if (!state.termsVersion) throw new Error('youeye_names_provisioning_material_missing');
  let current = state;
  if (!current.provisioning?.privateKeyPem || !current.provisioning.csrPem) {
    const generated = await io.generateCsr(state.fqdn);
    current = await advance(state.name, 'certificate_requested', {
      privateKeyPem: generated.keyPem,
      csrPem: generated.csrPem,
    });
  }
  await io.requestCertificate(current.name, current.provisioning!.csrPem!, state.termsVersion);
  return advance(current.name, 'certificate_waiting');
}

/**
 * The synchronous part of the job, up to the certificate request. Starting the
 * same name again never claims or requests again: it only reports the state.
 * A different name while a lease is held is refused (release it first).
 */
export function startNamesJob(input: NamesStartInput, io: NamesJobIO = defaultNamesJobIO): Promise<NamesJobStatus> {
  return serialStart(() => startNamesJobNow(input, io));
}

/** Report an existing (not released) job for this name, or refuse another name. */
function existingJobStatus(existing: NamesLifecycleState, name: string, fqdn: string): NamesJobStatus {
  if (existing.name !== name || existing.fqdn !== fqdn) {
    throw new NamesJobError('names_lease_held', `This server already holds ${existing.fqdn}. Continue with it, or release it first.`);
  }
  return namesJobStatusOf(existing);
}

async function startNamesJobNow(input: NamesStartInput, io: NamesJobIO): Promise<NamesJobStatus> {
  const name = typeof input.name === 'string' ? input.name.trim().toLowerCase() : '';
  const fqdn = typeof input.fqdn === 'string' ? input.fqdn.trim().toLowerCase().replace(/\.+$/, '') : '';
  if (!NAME_PATTERN.test(name) || !fqdn.startsWith(`${name}.`)) {
    throw new NamesJobError('names_name_invalid', 'Select a valid YouEye Names address first.', 400);
  }
  const existing = await readNamesLifecycleState();
  if (existing && existing.status !== 'released') return existingJobStatus(existing, name, fqdn);
  if (await getStagedBundle()) {
    throw new NamesJobError('names_bundle_staged', 'A saved YouEye Names address is waiting to be used. Continue with it.');
  }

  // The browser is not a trusted source of server addressing.
  const ip = (await io.currentIp()).trim();
  if (!privateNamesAddress(ip)) {
    throw new NamesJobError('names_private_address_unavailable', 'Could not determine this server’s private network address. Check its network connection and try again.');
  }
  const [terms, service] = await Promise.all([io.terms(), io.service()]);
  validateManagedName(service, name, fqdn, `*.${fqdn}`);
  if (input.ctAccepted !== true || typeof input.termsVersion !== 'string' || input.termsVersion !== terms.version) {
    throw new NamesJobError('names_terms_required', 'Review and accept the current YouEye Names certificate notice before continuing.', 400);
  }
  const session = input.verifiedSetupSession;
  const proof = input.humanVerificationProof;
  if (session !== undefined && (typeof session !== 'string' || session.length < 64 || session.length > 8192 || proof !== undefined)) {
    throw new NamesJobError('names_verification_invalid', 'Invalid setup verification session.', 400);
  }
  if (session === undefined && (typeof proof !== 'string' || proof.length < 20 || proof.length > 512)) {
    throw new NamesJobError('names_verification_required', 'Complete the YouEye Names verification first.', 400);
  }
  if (typeof session === 'string') await io.registerVerifiedSetup(session);
  // Claim (tolerate a lease this install already holds from an earlier attempt).
  try {
    await io.claim(name, ip, typeof proof === 'string' ? proof : undefined, typeof session === 'string' ? session : undefined);
  } catch (error) {
    if (!(error instanceof NamesBrokerError) || error.code !== 'install_already_has_active_lease') throw error;
    await io.getLease(name);
  }
  const startedAt = new Date().toISOString();
  const claimed: NamesLifecycleState = {
    schemaVersion: 1,
    service: namesServiceBinding(service),
    name,
    fqdn,
    status: 'provisioning',
    provisioning: {
      stage: 'lease_claimed',
      startedAt,
      lastAttemptAt: startedAt,
      brokerRequestId: null,
      privateKeyPem: null,
      csrPem: null,
    },
    termsVersion: terms.version,
    certificateTransparencyAcceptedAt: startedAt,
    certificate: null,
    lastBrokerContactAt: startedAt,
    lastHeartbeatAt: null,
    nextCheckAt: startedAt,
    lastError: null,
  };
  // Never over a job that appeared meanwhile: its key and CSR stay the only ones.
  const latest = await readNamesLifecycleState();
  if (latest && latest.status !== 'released') return existingJobStatus(latest, name, fqdn);
  await writeNamesLifecycleState(claimed);
  try {
    return namesJobStatusOf(await requestWithCsr(claimed, io));
  } catch (error) {
    await markNamesFailure(error).catch(() => undefined);
    throw error;
  }
}

async function waitForCertificate(state: NamesLifecycleState, io: NamesJobIO): Promise<CurrentCertificate> {
  const deadline = Date.now() + CERTIFICATE_WAIT_MS;
  let pollDelay = 2_000;
  while (Date.now() < deadline) {
    const certificate = await io.currentCertificate(state.name);
    if (certificate) return certificate;
    const current = await readNamesLifecycleState();
    if (current?.status !== 'provisioning' || current.name !== state.name) {
      throw new NamesJobError('names_job_cancelled', 'The YouEye Names address was released.');
    }
    await io.delay(pollDelay);
    pollDelay = Math.min(10_000, Math.round(pollDelay * 1.5));
  }
  throw new NamesJobError('names_certificate_timeout', JOB_MESSAGES.names_certificate_timeout);
}

/**
 * From any stored stage to `healthy`: the same key and CSR, the request when
 * no certificate exists yet (idempotent at the broker), the wait, validation,
 * Caddy and storage.
 */
async function completeNamesProvisioning(io: NamesJobIO): Promise<void> {
  let state = await readNamesLifecycleState();
  if (!state || state.status !== 'provisioning' || !state.provisioning) return;
  if (!state.termsVersion) throw new Error('youeye_names_provisioning_material_missing');
  const service = await io.service();
  if (
    service.id !== state.service.id ||
    service.canonicalOrigin !== state.service.canonicalOrigin ||
    service.managedZone !== state.service.managedZone
  ) throw new NamesJobError('youeye_names_provisioning_service_mismatch', JOB_MESSAGES.youeye_names_provisioning_service_mismatch);
  validateManagedName(service, state.name, state.fqdn, `*.${state.fqdn}`);
  // Once issued, a new request would be a renewal outside its window, so ask
  // for the certificate first. Otherwise repeat the request with the saved
  // CSR: the broker answers it with the same (pending or failed) job.
  let issued = state.provisioning.privateKeyPem && state.provisioning.csrPem
    ? await io.currentCertificate(state.name)
    : null;
  if (!issued) {
    state = await requestWithCsr(state, io);
    issued = await waitForCertificate(state, io);
  }
  const keyPem = state.provisioning!.privateKeyPem!;
  await advance(state.name, 'certificate_received');
  const validated = io.validate({ certificateChain: issued.certificateChain, privateKeyPem: keyPem, fqdn: state.fqdn });
  if (
    validated.brokerFingerprint !== issued.fingerprint ||
    !sameCertificateInstant(validated.expiresAt, issued.expiresAt)
  ) throw new NamesJobError('youeye_names_certificate_metadata_mismatch', JOB_MESSAGES.youeye_names_certificate_metadata_mismatch);
  await advance(state.name, 'activating');
  const domains = [...validated.domains];
  await withCaddyMutation(() => io.loadIntoCaddy(validated.certificateChain, keyPem, domains));
  await io.store({
    mode: 'manual',
    certPem: validated.certificateChain,
    keyPem,
    issuer: 'YouEye Names',
    domains,
    expiresAt: validated.expiresAt,
    issuedAt: validated.issuedAt,
  });
  const completedAt = new Date().toISOString();
  let cancelled = false;
  await updateNamesLifecycleState((current) => {
    if (current.status !== 'provisioning' || current.name !== state!.name) { cancelled = true; return current; }
    return {
      ...current,
      status: 'healthy',
      provisioning: null,
      certificate: {
        fingerprint: validated.fingerprint,
        provider: issued.provider,
        issuedAt: validated.issuedAt,
        expiresAt: validated.expiresAt,
      },
      lastBrokerContactAt: completedAt,
      nextCheckAt: new Date(Date.now() + CHECK_INTERVAL_MS).toISOString(),
      lastError: null,
    };
  });
  if (cancelled) return;
  console.log(`[youeye-names] certificate for ${state.fqdn} issued in ${Math.round((Date.parse(completedAt) - Date.parse(state.provisioning!.startedAt)) / 1000)} s (lease claimed ${state.provisioning!.startedAt}, active ${completedAt})`);
  try {
    const ip = (await io.currentIp()).trim();
    await io.heartbeat(state.name, {
      currentIp: ip,
      certificateFingerprint: validated.brokerFingerprint,
      certificateExpiresAt: validated.expiresAt,
      caddyStatus: 'healthy',
    });
    await updateNamesLifecycleState((current) => ({ ...current, lastHeartbeatAt: new Date().toISOString() }));
  } catch (error) {
    console.warn('[youeye-names] first heartbeat will retry automatically:', error instanceof Error ? error.message : 'unknown error');
  }
}

/**
 * Run (or join) the one background job that finishes a `provisioning` lease.
 * Shared by setup, provisioning, maintenance and Control Panel start.
 */
export function followNamesJob(io: NamesJobIO = defaultNamesJobIO): Promise<void> {
  if (job.follow) return job.follow;
  const run = io.exclusive(() => completeNamesProvisioning(io)).catch(async (error) => {
    if (!(error instanceof NamesJobError && error.code === 'names_job_cancelled')) {
      await markNamesFailure(error).catch(() => undefined);
      throw error;
    }
  }).finally(() => { job.follow = null; });
  job.follow = run;
  run.catch(() => undefined);
  return run;
}

/**
 * After a start that failed once the name was claimed (the certificate request,
 * say): begin the background wait and retry now instead of at the next
 * maintenance pass. Nothing to follow when no claim was recorded.
 */
export async function followClaimedNamesJob(io: NamesJobIO = defaultNamesJobIO): Promise<void> {
  const state = await readNamesLifecycleState();
  if (state?.status === 'provisioning') await followNamesJob(io);
}

/**
 * Provisioning: the certificate for exactly this name, never a new claim or
 * request. Joins or resumes the job and returns once lifecycle.json is healthy.
 */
export async function awaitNamesCertificate(name: string, fqdn: string, io: NamesJobIO = defaultNamesJobIO): Promise<void> {
  const state = await readNamesLifecycleState();
  if (!state || state.status === 'released' || state.name !== name || state.fqdn !== fqdn) {
    throw new NamesJobError('names_job_missing', JOB_MESSAGES.names_job_missing);
  }
  if (state.status === 'provisioning') await followNamesJob(io);
  const after = await readNamesLifecycleState();
  if (!after || after.name !== name || after.status === 'released') {
    throw new NamesJobError('names_job_missing', JOB_MESSAGES.names_job_missing);
  }
  if (after.status === 'provisioning' || !after.certificate) {
    throw new NamesJobError('names_certificate_timeout', JOB_MESSAGES.names_certificate_timeout);
  }
}

/** Activate: load the stored certificate for this name into Caddy. Idempotent. */
export async function activateNamesCertificate(fqdn: string, io: NamesJobIO = defaultNamesJobIO): Promise<void> {
  const stored = await io.storedCertificate();
  if (!stored || !stored.domains.includes(fqdn)) {
    throw new NamesJobError('names_certificate_missing', 'The YouEye Names certificate is not stored on this server. Retry this step.');
  }
  await withCaddyMutation(() => io.loadIntoCaddy(stored.certPem, stored.keyPem, stored.domains));
}

/**
 * A saved name staged before setup (`youeye names import`): install its certificate,
 * resume the lease and point it at this server. No new claim or certificate.
 */
export async function activateStagedNamesBundle(name: string, fqdn: string): Promise<boolean> {
  const staged = await getStagedBundle();
  if (!staged) return false;
  if (staged.name !== name || staged.fqdn !== fqdn) {
    throw new Error(`The saved name is for ${staged.fqdn}, but setup selected ${fqdn}.`);
  }
  if (!bundleCertStillValid(staged)) {
    throw new Error(`The saved certificate for ${staged.fqdn} has expired. Remove the saved name and choose a new one.`);
  }
  const ip = (await spineClient.getMetrics()).primary_ip.trim();
  if (!privateNamesAddress(ip)) {
    throw new Error('Could not determine this server’s private network address. Check its network connection and try again.');
  }
  const identity = validateStoredIdentity(staged.identity).identity;
  const domains = [fqdn, `*.${fqdn}`];
  await withCaddyMutation(() => caddy.loadExternalCert(staged.tls.certPem, staged.tls.keyPem, domains));
  await tlsStorage.storeCert({
    mode: 'manual', certPem: staged.tls.certPem, keyPem: staged.tls.keyPem,
    issuer: 'YouEye Names', domains,
    expiresAt: staged.certificate.expiresAt,
    issuedAt: staged.certificate.issuedAt,
  });
  // Resume the lease and repoint DNS at this server's current IP (DNS only).
  try {
    await claimName(staged.name, ip, identity);
  } catch (error) {
    if (!(error instanceof NamesBrokerError) || error.code !== 'install_already_has_active_lease') throw error;
    await getLease(staged.name, identity);
  }
  await updateIp(staged.name, ip, identity);
  await applyBundleIdentity(staged);
  const activatedAt = new Date().toISOString();
  await writeNamesLifecycleState({
    schemaVersion: 1,
    service: staged.service,
    name: staged.name,
    fqdn,
    status: 'healthy',
    provisioning: null,
    termsVersion: staged.consent.termsVersion,
    certificateTransparencyAcceptedAt: staged.consent.certificateTransparencyAcceptedAt,
    certificate: {
      fingerprint: staged.certificate.fingerprint,
      provider: staged.certificate.provider,
      issuedAt: staged.certificate.issuedAt,
      expiresAt: staged.certificate.expiresAt,
    },
    lastBrokerContactAt: activatedAt,
    lastHeartbeatAt: null,
    nextCheckAt: new Date(Date.now() + CHECK_INTERVAL_MS).toISOString(),
    lastError: null,
  });
  await consumeStagedBundle();
  try {
    await heartbeat(staged.name, {
      currentIp: ip,
      certificateFingerprint: validateCertificateMaterial({
        certificateChain: staged.tls.certPem,
        privateKeyPem: staged.tls.keyPem,
        fqdn,
      }).brokerFingerprint,
      certificateExpiresAt: staged.certificate.expiresAt,
      caddyStatus: 'healthy',
    }, identity);
    await updateNamesLifecycleState((state) => ({ ...state, lastHeartbeatAt: new Date().toISOString() }));
  } catch (error) {
    console.warn('[youeye-names] first heartbeat will retry automatically:', error instanceof Error ? error.message : 'unknown error');
  }
  return true;
}
