/**
 * Typed, server-side YouEye Names broker client.
 *
 * Browser code talks only to Control Panel routes. This module validates every
 * broker response, bounds response bodies and deadlines, preserves request IDs,
 * signs each attempt independently, and solves adaptive proof-of-work away from
 * the main Node event loop.
 */
import crypto from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Worker } from 'node:worker_threads';
import { z } from 'zod';
import {
  getInstallIdentity,
  signPayload,
  type InstallIdentity,
} from './identity';
import {
  discoverNamesService,
  namesReadinessSchema,
  resetNamesServiceCache,
  validateManagedName,
  type NamesReadiness,
  type NamesService,
} from './service';
const REQUEST_TIMEOUT_MS = Number(
  process.env.YOUEYE_NAMES_REQUEST_TIMEOUT_MS || '20000',
);
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_RETRY_DELAY_MS = 10_000;
const MAX_ATTEMPTS = 3;

const isoDate = z.string().datetime({ offset: true });
const nullableIsoDate = isoDate.nullable();
const requestIdSchema = z.string().min(1).max(256).optional();

const namePreviewSchema = z.object({
  name: z.string().min(1).max(63),
  fqdn: z.string().min(1).max(253),
  wildcardFqdn: z.string().min(3).max(255),
  available: z.boolean(),
});

const leaseSchema = z.object({
  name: z.string().min(1).max(63),
  installFingerprint: z.string().min(32).max(256),
  status: z.enum([
    'pending_certificate',
    'active',
    'grace',
    'quarantined',
    'revoked',
    'reclaimed',
  ]),
  currentIp: z.string().min(1).max(64),
  createdAt: isoDate,
  updatedAt: isoDate,
  lastHeartbeatAt: nullableIsoDate,
  certificateFingerprint: z.string().max(256).nullable(),
  certificateExpiresAt: nullableIsoDate,
  cooldownUntil: nullableIsoDate.optional(),
  quarantineReason: z.string().max(512).nullable().optional(),
  latestYoueyeVersion: z.string().max(128).nullable().optional(),
  latestCaddyStatus: z.string().max(128).nullable().optional(),
  latestRenewalNeeded: z.boolean().optional(),
  releasedAt: nullableIsoDate.optional(),
  deleteAfter: nullableIsoDate.optional(),
});

const certificateSchema = z.object({
  id: z.string().optional(),
  leaseName: z.string().optional(),
  certificateChain: z.string().min(64).max(192 * 1024),
  fingerprint: z.string().min(16).max(256),
  provider: z.enum(['letsencrypt', 'google-public-ca']),
  issuedAt: isoDate,
  expiresAt: isoDate,
  revokedAt: nullableIsoDate,
  revocationReason: z.string().nullable().optional(),
  retainedUntil: isoDate.optional(),
  ariWindowStart: nullableIsoDate.optional(),
  ariWindowEnd: nullableIsoDate.optional(),
  ariRenewAfter: nullableIsoDate.optional(),
});

const termsSchema = z.object({
  version: z.string().min(1).max(64),
  certificateTransparencyRequired: z.literal(true),
  humanIdentityRequired: z.boolean(),
  summary: z.string().min(1).max(4096),
});

const privacyNoticeSchema = z.object({
  version: z.string().min(1).max(64),
  accountRequired: z.boolean(),
  rawSourceIpStoredByApplication: z.boolean(),
  rotatingAbuseIdentifiers: z.object({
    individualIpHours: z.number().int().nonnegative(),
    subnetDays: z.number().int().nonnegative(),
  }),
  certificateTransparencyPublic: z.boolean(),
  tlsPrivateKeyLeavesDevice: z.literal(false).optional(),
  proxiesYouEyeTraffic: z.literal(false).optional(),
  processors: z.array(z.object({
    name: z.string().min(1).max(128),
    purposes: z.array(z.string().min(1).max(256)).max(16),
  })).max(16).optional(),
  retention: z.object({
    terminalCsrDays: z.number().int().nonnegative(),
    terminalJobsDays: z.number().int().nonnegative(),
    normalAuditDays: z.number().int().nonnegative(),
    securityAuditDays: z.number().int().nonnegative(),
    releasedInstallMinimumDays: z.number().int().nonnegative(),
    certificateAfterExpiryDays: z.number().int().nonnegative(),
  }),
});

const proofChallengeSchema = z.object({
  token: z.string().min(1).max(2048),
  difficulty: z.number().int().min(8).max(28),
  expiresAt: isoDate,
});

const errorBodySchema = z.object({
  ok: z.literal(false).optional(),
  error: z.string().min(1).max(256).optional(),
  decision: z.string().min(1).max(256).optional(),
  requestId: requestIdSchema,
  retryAfterSeconds: z.number().nonnegative().optional(),
  challenge: proofChallengeSchema.optional(),
  renewalAfter: isoDate.optional(),
});

export type NamePreview = z.infer<typeof namePreviewSchema>;
export type NamesLease = z.infer<typeof leaseSchema>;
export type CurrentCertificate = z.infer<typeof certificateSchema>;
export type CertificateTerms = z.infer<typeof termsSchema>;
export type PrivacyNotice = z.infer<typeof privacyNoticeSchema>;
export type ProofChallenge = z.infer<typeof proofChallengeSchema>;
export type HumanVerificationPurpose = 'install_register' | 'lease_claim';
export type HumanVerificationChallenge = {
  purpose: HumanVerificationPurpose;
  serviceOrigin: string;
  enrollmentUrl: string;
  context: string;
  cdata: string;
  publicKey: string;
  installFingerprint: string;
  expiresAt: string;
  name?: string;
};

export interface HeartbeatInput {
  currentIp?: string;
  certificateFingerprint?: string;
  certificateExpiresAt?: string;
  youeyeVersion?: string;
  caddyStatus?: string;
  renewalNeeded?: boolean;
}

export class NamesBrokerError extends Error {
  readonly status: number;
  readonly code: string;
  readonly decision?: string;
  readonly requestId?: string;
  readonly retryAfterSeconds?: number;
  readonly challenge?: ProofChallenge;
  readonly renewalAfter?: string;

  constructor(input: {
    status: number;
    code: string;
    decision?: string;
    requestId?: string;
    retryAfterSeconds?: number;
    challenge?: ProofChallenge;
    renewalAfter?: string;
  }) {
    super(input.code);
    this.name = 'NamesBrokerError';
    this.status = input.status;
    this.code = input.code;
    this.decision = input.decision;
    this.requestId = input.requestId;
    this.retryAfterSeconds = input.retryAfterSeconds;
    this.challenge = input.challenge;
    this.renewalAfter = input.renewalAfter;
  }
}

/** Calm user-facing copy while preserving the request ID for support. */
export function namesErrorMessage(error: unknown): string {
  if (!(error instanceof NamesBrokerError)) {
    return 'YouEye Names could not be reached. Your current setup was not changed.';
  }
  const messages: Record<string, string> = {
    proof_of_work_not_found: 'The safety check took too long. Please try again.',
    proof_of_work_required: 'The safety check could not be completed. Please try again.',
    request_cooldown: 'YouEye Names is asking this device to wait before trying again.',
    request_quarantined: 'YouEye Names has paused requests from this device.',
    admission_paused: 'New YouEye Names registrations are temporarily paused.',
    certificate_not_ready: 'Your secure certificate is still being prepared.',
    certificate_terms_version_required:
      'The YouEye Names certificate terms have changed. Please review them again.',
    install_already_has_active_lease:
      'This YouEye already has a YouEye Names address.',
    lease_not_found: 'This saved YouEye Names address is no longer available.',
    lease_forbidden: 'The saved identity does not control this YouEye Names address.',
  };
  const message = messages[error.code] ||
    (error.status >= 500
      ? 'YouEye Names is temporarily unavailable. Your current setup was not changed.'
      : 'YouEye Names could not complete that request.');
  return error.requestId ? `${message} Reference: ${error.requestId}` : message;
}

type Proof = { token: string; nonce: string };

function retryAfterFromHeader(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

async function readJsonBody(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new NamesBrokerError({
      status: 502,
      code: 'broker_response_too_large',
      requestId: response.headers.get('x-request-id') || undefined,
    });
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_RESPONSE_BYTES) {
    throw new NamesBrokerError({
      status: 502,
      code: 'broker_response_too_large',
      requestId: response.headers.get('x-request-id') || undefined,
    });
  }
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    throw new NamesBrokerError({
      status: 502,
      code: 'broker_response_json_invalid',
      requestId: response.headers.get('x-request-id') || undefined,
    });
  }
}

async function parseResponse<T>(
  response: Response,
  schema: z.ZodType<T>,
): Promise<T> {
  const body = await readJsonBody(response);
  if (!response.ok) {
    const parsed = errorBodySchema.safeParse(body);
    const headerRequestId = response.headers.get('x-request-id') || undefined;
    throw new NamesBrokerError({
      status: response.status,
      code: parsed.success ? parsed.data.error || 'broker_request_failed' : 'broker_error_invalid',
      decision: parsed.success ? parsed.data.decision : undefined,
      requestId: parsed.success ? parsed.data.requestId || headerRequestId : headerRequestId,
      retryAfterSeconds: parsed.success
        ? parsed.data.retryAfterSeconds ?? retryAfterFromHeader(response.headers.get('retry-after'))
        : retryAfterFromHeader(response.headers.get('retry-after')),
      challenge: parsed.success ? parsed.data.challenge : undefined,
      renewalAfter: parsed.success ? parsed.data.renewalAfter : undefined,
    });
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new NamesBrokerError({
      status: 502,
      code: 'broker_response_contract_invalid',
      requestId:
        typeof body === 'object' && body && 'requestId' in body
          ? String((body as { requestId?: unknown }).requestId || '') || undefined
          : response.headers.get('x-request-id') || undefined,
    });
  }
  return parsed.data;
}

async function fetchWithDeadline(
  url: string,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch {
    if (controller.signal.aborted) {
      throw new NamesBrokerError({ status: 504, code: 'broker_request_timeout' });
    }
    throw new NamesBrokerError({
      status: 503,
      code: 'broker_network_unavailable',
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function requestJson<T>(input: {
  makeRequest: () => Promise<Response>;
  schema: z.ZodType<T>;
  retryable: boolean;
}): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= (input.retryable ? MAX_ATTEMPTS : 1); attempt += 1) {
    try {
      return await parseResponse(await input.makeRequest(), input.schema);
    } catch (error) {
      lastError = error;
      const retryable =
        error instanceof NamesBrokerError &&
        (error.status === 503 || error.status === 504) &&
        attempt < MAX_ATTEMPTS;
      if (!retryable) throw error;
      const suggested = error.retryAfterSeconds
        ? error.retryAfterSeconds * 1000
        : 250 * 2 ** (attempt - 1);
      await delay(Math.min(MAX_RETRY_DELAY_MS, suggested) + crypto.randomInt(150));
    }
  }
  throw lastError;
}

const proofWorkerSource = String.raw`
  const { parentPort, workerData } = require('node:worker_threads');
  const crypto = require('node:crypto');
  function hasLeadingZeroBits(value, bits) {
    let remaining = bits;
    for (const byte of value) {
      if (remaining >= 8) {
        if (byte !== 0) return false;
        remaining -= 8;
        continue;
      }
      if (remaining === 0) return true;
      return (byte >> (8 - remaining)) === 0;
    }
    return remaining === 0;
  }
  let solved;
  for (let value = 0; value < 20000000; value += 1) {
    const nonce = value.toString(36);
    const digest = crypto.createHash('sha256').update(workerData.token + ':' + nonce).digest();
    if (hasLeadingZeroBits(digest, workerData.difficulty)) {
      solved = nonce;
      break;
    }
  }
  parentPort.postMessage(solved ? { nonce: solved } : { error: 'proof_of_work_not_found' });
`;

/** Solve a broker challenge in an isolated worker with an expiry-bounded budget. */
export async function solveProofOfWork(challenge: ProofChallenge): Promise<Proof> {
  const parsed = proofChallengeSchema.parse(challenge);
  const expiresIn = Date.parse(parsed.expiresAt) - Date.now();
  if (expiresIn <= 1_000) {
    throw new NamesBrokerError({ status: 429, code: 'proof_of_work_expired' });
  }
  const budget = Math.min(30_000, expiresIn - 500);
  const worker = new Worker(proofWorkerSource, {
    eval: true,
    workerData: { token: parsed.token, difficulty: parsed.difficulty },
  });
  return new Promise<Proof>((resolve, reject) => {
    const timeout = setTimeout(() => {
      void worker.terminate();
      reject(new NamesBrokerError({ status: 429, code: 'proof_of_work_timeout' }));
    }, budget);
    worker.once('message', (message: { nonce?: unknown; error?: unknown }) => {
      clearTimeout(timeout);
      void worker.terminate();
      if (typeof message.nonce === 'string') {
        resolve({ token: parsed.token, nonce: message.nonce });
      } else {
        reject(
          new NamesBrokerError({
            status: 429,
            code:
              typeof message.error === 'string'
                ? message.error
                : 'proof_of_work_failed',
          }),
        );
      }
    });
    worker.once('error', (error) => {
      clearTimeout(timeout);
      reject(
        new NamesBrokerError({
          status: 500,
          code: `proof_worker_failed:${error.name}`,
        }),
      );
    });
  });
}

async function withProof<T>(operation: (proof?: Proof) => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!(error instanceof NamesBrokerError) || !error.challenge) throw error;
    return operation(await solveProofOfWork(error.challenge));
  }
}

const registrations = new Map<string, Promise<void>>();

/** Register one broker origin/fingerprint pair, including adaptive proof. */
async function ensureRegistered(
  identity: InstallIdentity,
  service: NamesService,
  humanVerificationProof?: string,
): Promise<void> {
  const key = `${service.id}\0${service.canonicalOrigin}\0${identity.fingerprint}`;
  const existing = registrations.get(key);
  if (existing) return existing;
  const registration = withProof(async (proof) => {
    const body = {
      publicKey: identity.publicKeyRaw,
      ...(humanVerificationProof ? { humanVerificationProof } : {}),
      ...(proof ? { proof } : {}),
    };
    await requestJson({
      makeRequest: () =>
        fetchWithDeadline(`${service.canonicalOrigin}/v1/installs/register`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      schema: z.object({
        ok: z.literal(true),
        requestId: requestIdSchema,
        idempotent: z.boolean().optional(),
        install: z.object({ fingerprint: z.string().min(32).max(256) }),
      }),
      retryable: true,
    });
  });
  registrations.set(key, registration);
  try {
    await registration;
  } catch (error) {
    registrations.delete(key);
    throw error;
  }
}

async function signedJson<T>(input: {
  method: 'GET' | 'POST';
  path: string;
  body?: Record<string, unknown>;
  schema: z.ZodType<T>;
  retryable?: boolean;
  identity?: InstallIdentity;
  service?: NamesService;
}): Promise<T> {
  const identity = input.identity || (await getInstallIdentity());
  const service = input.service || (await discoverNamesService());
  await ensureRegistered(identity, service);
  return withProof(async (proof) => {
    const body = input.body
      ? { ...input.body, ...(proof ? { proof } : {}) }
      : undefined;
    return requestJson({
      makeRequest: async () => {
        const bodyString = body === undefined ? '' : JSON.stringify(body);
        const timestamp = String(Math.floor(Date.now() / 1000));
        const nonce = crypto.randomBytes(18).toString('base64url');
        const bodyHash = crypto
          .createHash('sha256')
          .update(bodyString)
          .digest('hex');
        const payload = [
          input.method,
          input.path,
          timestamp,
          nonce,
          bodyHash,
          service.id,
          service.canonicalOrigin,
        ].join('\n');
        return fetchWithDeadline(`${service.canonicalOrigin}${input.path}`, {
          method: input.method,
          headers: {
            'content-type': 'application/json',
            'x-youeye-install-fingerprint': identity.fingerprint,
            'x-youeye-timestamp': timestamp,
            'x-youeye-nonce': nonce,
            'x-youeye-signature': signPayload(identity, payload),
            'x-youeye-service-id': service.id,
            'x-youeye-service-origin': service.canonicalOrigin,
          },
          body: input.method === 'GET' ? undefined : bodyString,
        });
      },
      schema: input.schema,
      retryable: input.retryable ?? true,
    });
  });
}

async function publicJson<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  const service = await discoverNamesService();
  return requestJson({
    makeRequest: () => fetchWithDeadline(`${service.canonicalOrigin}${path}`, { method: 'GET' }),
    schema,
    retryable: true,
  });
}

export async function getCertificateTerms(): Promise<CertificateTerms> {
  const response = await publicJson(
    '/v1/certificate-terms/current',
    z.object({ ok: z.literal(true), requestId: requestIdSchema, terms: termsSchema }),
  );
  return response.terms;
}

export async function getPrivacyNotice(): Promise<PrivacyNotice> {
  const response = await publicJson(
    '/v1/privacy-notice/current',
    z.object({
      ok: z.literal(true),
      requestId: requestIdSchema,
      notice: privacyNoticeSchema,
    }),
  );
  return response.notice;
}

export async function getNamesReadiness(): Promise<NamesReadiness> {
  const service = await discoverNamesService();
  const response = await publicJson(
    '/v1/readiness',
    z.object({ ok: z.literal(true), requestId: requestIdSchema, readiness: namesReadinessSchema }),
  );
  if (
    response.readiness.service.id !== service.id ||
    response.readiness.service.canonicalOrigin !== service.canonicalOrigin ||
    response.readiness.service.managedZone !== service.managedZone
  ) {
    throw new NamesBrokerError({ status: 502, code: 'broker_readiness_identity_mismatch' });
  }
  return response.readiness;
}

const humanVerificationChallengeResponseSchema = z.object({
  ok: z.literal(true),
  requestId: requestIdSchema,
  siteKey: z.string().min(1).max(512),
  action: z.literal('youeye_names_enrollment'),
  cData: z.string().min(1).max(64),
  expiresAt: isoDate,
  context: z.string().min(20).max(4096),
  enrollmentUrl: z.string().url(),
  name: z.string().min(1).max(63).optional(),
});

/** Issue an ephemeral popup challenge without returning the server IP to browser code. */
export async function createHumanVerificationChallenge(
  purpose: HumanVerificationPurpose,
  input: { name?: string; currentIp?: string } = {},
): Promise<HumanVerificationChallenge> {
  const [service, identity] = await Promise.all([
    discoverNamesService(),
    getInstallIdentity(),
  ]);
  let response: z.infer<typeof humanVerificationChallengeResponseSchema>;
  if (purpose === 'install_register') {
    response = await requestJson({
      makeRequest: () => fetchWithDeadline(`${service.canonicalOrigin}/v1/human-verification/challenges`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ purpose, publicKey: identity.publicKeyRaw }),
      }),
      schema: humanVerificationChallengeResponseSchema,
      retryable: true,
    });
  } else {
    if (!input.name || !input.currentIp) throw new Error('youeye_names_claim_binding_missing');
    response = await signedJson({
      method: 'POST',
      path: '/v1/human-verification/challenges',
      body: { purpose, name: input.name, currentIp: input.currentIp },
      schema: humanVerificationChallengeResponseSchema,
      identity,
      service,
    });
    if (response.name !== input.name) throw new NamesBrokerError({ status: 502, code: 'broker_claim_binding_mismatch' });
  }
  const enrollment = new URL(response.enrollmentUrl);
  if (enrollment.origin !== service.canonicalOrigin || enrollment.pathname !== '/enroll') {
    throw new NamesBrokerError({ status: 502, code: 'broker_enrollment_origin_mismatch' });
  }
  return {
    purpose,
    serviceOrigin: service.canonicalOrigin,
    enrollmentUrl: `${service.canonicalOrigin}/enroll`,
    context: response.context,
    cdata: response.cData,
    publicKey: identity.publicKeyRaw,
    installFingerprint: identity.fingerprint,
    expiresAt: response.expiresAt,
    ...(response.name ? { name: response.name } : {}),
  };
}

export async function registerInstall(humanVerificationProof: string): Promise<void> {
  if (humanVerificationProof.length < 20 || humanVerificationProof.length > 512) {
    throw new Error('youeye_names_human_verification_proof_invalid');
  }
  const [service, identity] = await Promise.all([discoverNamesService(), getInstallIdentity()]);
  await ensureRegistered(identity, service, humanVerificationProof);
}

/** Generated options are non-committing: no lease, DNS, or certificate work. */
export async function previewNames(count: number): Promise<NamePreview[]> {
  const service = await discoverNamesService();
  const response = await signedJson({
    method: 'POST',
    path: '/v1/leases/preview',
    body: { count },
    schema: z.object({
      ok: z.literal(true),
      requestId: requestIdSchema,
      previews: z.array(namePreviewSchema).max(10),
      committed: z.literal(false),
      claimRequired: z.literal(true),
    }),
    service,
  });
  for (const preview of response.previews) {
    validateManagedName(service, preview.name, preview.fqdn, preview.wildcardFqdn);
  }
  return response.previews;
}

export async function previewName(name: string): Promise<NamePreview | null> {
  const service = await discoverNamesService();
  const response = await signedJson({
    method: 'POST',
    path: '/v1/leases/preview',
    body: { name },
    schema: z.object({
      ok: z.literal(true),
      requestId: requestIdSchema,
      previews: z.array(namePreviewSchema).max(1),
      committed: z.literal(false),
      claimRequired: z.literal(true),
    }),
    service,
  });
  for (const preview of response.previews) {
    validateManagedName(service, preview.name, preview.fqdn, preview.wildcardFqdn);
  }
  return response.previews[0] || null;
}

export async function claimName(
  name: string,
  currentIp: string,
  identity?: InstallIdentity,
  humanVerificationProof?: string,
): Promise<NamesLease> {
  const response = await signedJson({
    method: 'POST',
    path: '/v1/leases/claim',
    body: { name, currentIp, ...(humanVerificationProof ? { humanVerificationProof } : {}) },
    schema: z.object({
      ok: z.literal(true),
      requestId: requestIdSchema,
      idempotent: z.boolean().optional(),
      lease: leaseSchema,
    }),
    identity,
  });
  return response.lease;
}

export async function getLease(
  name: string,
  identity?: InstallIdentity,
): Promise<NamesLease> {
  const response = await signedJson({
    method: 'GET',
    path: `/v1/leases/${encodeURIComponent(name)}`,
    schema: z.object({
      ok: z.literal(true),
      requestId: requestIdSchema,
      lease: leaseSchema,
    }),
    identity,
  });
  return response.lease;
}

export async function heartbeat(
  name: string,
  heartbeatBody: HeartbeatInput,
  identity?: InstallIdentity,
): Promise<{ lease: NamesLease; csrRequired: boolean; coalesced: boolean }> {
  const response = await signedJson({
    method: 'POST',
    path: `/v1/leases/${encodeURIComponent(name)}/heartbeat`,
    body: { ...heartbeatBody },
    schema: z.object({
      ok: z.literal(true),
      requestId: requestIdSchema,
      coalesced: z.boolean(),
      lease: leaseSchema,
      renewal: z.object({ csrRequired: z.boolean() }),
    }),
    identity,
  });
  return {
    lease: response.lease,
    csrRequired: response.renewal.csrRequired,
    coalesced: response.coalesced,
  };
}

export async function requestCertificate(
  name: string,
  csrPem: string,
  termsVersion: string,
  certificateTransparencyAccepted: true,
  identity?: InstallIdentity,
): Promise<{ id: string; type: string; status: string; provider: string }> {
  const response = await signedJson({
    method: 'POST',
    path: `/v1/leases/${encodeURIComponent(name)}/certificates/request`,
    body: { csrPem, termsVersion, certificateTransparencyAccepted },
    schema: z.object({
      ok: z.literal(true),
      requestId: requestIdSchema,
      idempotent: z.boolean().optional(),
      job: z.object({
        id: z.string().min(1),
        type: z.string().min(1),
        status: z.string().min(1),
        provider: z.string().min(1),
      }),
    }),
    identity,
  });
  return response.job;
}

export async function getCurrentCertificate(
  name: string,
  identity?: InstallIdentity,
): Promise<CurrentCertificate | null> {
  try {
    const response = await signedJson({
      method: 'GET',
      path: `/v1/leases/${encodeURIComponent(name)}/certificates/current`,
      schema: z.object({
        ok: z.literal(true),
        requestId: requestIdSchema,
        certificate: certificateSchema,
      }),
      identity,
    });
    return response.certificate;
  } catch (error) {
    if (error instanceof NamesBrokerError && error.code === 'certificate_not_ready') {
      return null;
    }
    throw error;
  }
}

export async function updateIp(
  name: string,
  ip: string,
  identity?: InstallIdentity,
): Promise<NamesLease> {
  const response = await signedJson({
    method: 'POST',
    path: `/v1/leases/${encodeURIComponent(name)}/ip`,
    body: { ip },
    schema: z.object({
      ok: z.literal(true),
      requestId: requestIdSchema,
      lease: leaseSchema,
      dnsSyncQueued: z.boolean(),
      certificateJobCreated: z.literal(false),
    }),
    identity,
  });
  return response.lease;
}

export async function exportInstallData(
  name: string,
): Promise<Record<string, unknown>> {
  const response = await signedJson({
    method: 'GET',
    path: `/v1/leases/${encodeURIComponent(name)}/data-export`,
    schema: z.object({
      ok: z.literal(true),
      requestId: requestIdSchema,
      data: z.record(z.string(), z.unknown()),
    }),
  });
  return response.data;
}

export async function releaseName(name: string): Promise<NamesLease> {
  const response = await signedJson({
    method: 'POST',
    path: `/v1/leases/${encodeURIComponent(name)}/release`,
    schema: z.object({
      ok: z.literal(true),
      requestId: requestIdSchema,
      lease: leaseSchema,
      dnsRemovalQueued: z.literal(true),
    }),
    retryable: false,
  });
  return response.lease;
}

export async function revokeCertificate(
  name: string,
  fingerprint: string,
  reason:
    | 'key_compromise'
    | 'cessation_of_operation'
    | 'superseded'
    | 'privilege_withdrawn',
): Promise<void> {
  await signedJson({
    method: 'POST',
    path: `/v1/leases/${encodeURIComponent(name)}/certificates/revoke`,
    body: { fingerprint, reason },
    schema: z.object({
      ok: z.literal(true),
      requestId: requestIdSchema,
      idempotent: z.boolean().optional(),
      job: z.object({ id: z.string(), type: z.string(), status: z.string() }),
    }),
  });
}

export function resetBrokerRegistrationCache(): void {
  registrations.clear();
  resetNamesServiceCache();
}
