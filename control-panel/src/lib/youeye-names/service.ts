import { z } from 'zod';

export const OFFICIAL_NAMES_SERVICE_URL = 'https://names.youeye.me';
export const OFFICIAL_NAMES_SERVICE_ID = 'youeye-names-official';

const serviceInfoSchema = z.object({
  ok: z.literal(true),
  requestId: z.string().min(1).max(256).optional(),
  service: z.object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{2,63}$/),
    canonicalOrigin: z.string().url(),
    managedZone: z.string().min(1).max(253),
    apiVersion: z.literal('v1'),
    environment: z.enum(['production', 'beta', 'development', 'custom']),
    capabilities: z.array(z.string().min(1).max(64)).max(32),
    certificateTermsVersion: z.string().min(1).max(64),
    privacyNoticeVersion: z.string().min(1).max(64),
    privacyPolicyUrl: z.string().url().optional(),
  }),
});

const componentStateSchema = z.enum([
  'available',
  'degraded',
  'unavailable',
  'misconfigured',
  'exhausted',
  'circuit_open',
]);

export const namesReadinessSchema = z.object({
  contractVersion: z.literal('v1'),
  service: z.object({
    id: z.string(),
    canonicalOrigin: z.string().url(),
    managedZone: z.string(),
    environment: z.enum(['production', 'beta', 'development', 'custom']),
  }),
  reachability: z.object({ reachable: z.boolean(), state: z.enum(['reachable', 'unavailable']) }),
  installation: z.object({
    canProceedNow: z.boolean(),
    state: z.enum(['ready', 'challenge', 'degraded', 'paused', 'blocked']),
    reasonCodes: z.array(z.string()).max(32),
  }),
  humanVerification: z.object({
    provider: z.literal('turnstile'),
    state: z.enum(['active', 'unconfigured', 'invalid']),
    admissionReady: z.boolean(),
  }),
  admission: z.object({
    mode: z.enum(['normal', 'challenge', 'registrations_paused', 'initial_issuance_paused', 'emergency']),
    issuancePaused: z.boolean(),
  }),
  dns: z.object({
    provider: z.enum(['cloudflare', 'powerdns-controller']),
    state: componentStateSchema,
  }),
  queues: z.object({
    contained: z.boolean(),
    dns: z.enum(['available', 'exhausted']),
    certificate: z.enum(['available', 'exhausted']),
  }),
  initialCertificate: z.object({
    available: z.boolean(),
    primary: z.object({ provider: z.enum(['google-public-ca', 'letsencrypt']), state: componentStateSchema }),
    fallback: z.object({ provider: z.enum(['google-public-ca', 'letsencrypt']), state: componentStateSchema }),
    assurance: z.literal('availability_only_not_issuance_promise'),
  }),
});

export type NamesServiceInfo = z.infer<typeof serviceInfoSchema>['service'];
export type NamesService = NamesServiceInfo & { url: string };
export type NamesReadiness = z.infer<typeof namesReadinessSchema>;
export type NamesServiceBinding = {
  id: string;
  canonicalOrigin: string;
  apiVersion: 'v1';
  managedZone: string;
};

const DISCOVERY_TTL_MS = 60_000;
let cached: { service: NamesService; expiresAt: number } | null = null;

export function normaliseNamesServiceOrigin(input: string): string {
  let parsed: URL;
  try {
    parsed = new URL(input.trim());
  } catch {
    throw new Error('youeye_names_service_origin_invalid');
  }
  if (
    parsed.protocol !== 'https:' || parsed.username || parsed.password ||
    parsed.pathname !== '/' || parsed.search || parsed.hash
  ) {
    throw new Error('youeye_names_service_origin_invalid');
  }
  return parsed.origin;
}

export function configuredNamesServiceOrigin(): string {
  return normaliseNamesServiceOrigin(process.env.YOUEYE_NAMES_URL || OFFICIAL_NAMES_SERVICE_URL);
}

export function expectedNamesServiceId(): string {
  return process.env.YOUEYE_NAMES_EXPECTED_SERVICE_ID || OFFICIAL_NAMES_SERVICE_ID;
}

export function validateNamesServiceDocument(input: unknown, contactedOrigin: string): NamesService {
  const parsed = serviceInfoSchema.safeParse(input);
  if (!parsed.success) throw new Error('youeye_names_service_contract_invalid');
  const canonicalOrigin = normaliseNamesServiceOrigin(parsed.data.service.canonicalOrigin);
  if (canonicalOrigin !== contactedOrigin) throw new Error('youeye_names_service_origin_mismatch');
  if (parsed.data.service.id !== expectedNamesServiceId()) throw new Error('youeye_names_service_identity_mismatch');
  const required = ['install-signatures', 'lease-lifecycle', 'certificate-lifecycle'];
  if (required.some((capability) => !parsed.data.service.capabilities.includes(capability))) {
    throw new Error('youeye_names_service_capabilities_missing');
  }
  const managedZone = parsed.data.service.managedZone.toLowerCase().replace(/\.$/, '');
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(managedZone)) {
    throw new Error('youeye_names_service_zone_invalid');
  }
  return { ...parsed.data.service, canonicalOrigin, managedZone, url: contactedOrigin };
}

export async function discoverNamesService(force = false): Promise<NamesService> {
  if (!force && cached && cached.expiresAt > Date.now()) return cached.service;
  const origin = configuredNamesServiceOrigin();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(`${origin}/v1/service-info`, {
      method: 'GET',
      redirect: 'manual',
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok || (response.status >= 300 && response.status < 400)) {
      throw new Error('youeye_names_service_unavailable');
    }
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > 64 * 1024) throw new Error('youeye_names_service_contract_too_large');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 64 * 1024) throw new Error('youeye_names_service_contract_too_large');
    let body: unknown;
    try { body = JSON.parse(bytes.toString('utf8')) as unknown; }
    catch { throw new Error('youeye_names_service_contract_invalid'); }
    const service = validateNamesServiceDocument(body, origin);
    cached = { service, expiresAt: Date.now() + DISCOVERY_TTL_MS };
    return service;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('youeye_names_')) throw error;
    throw new Error('youeye_names_service_unavailable');
  } finally {
    clearTimeout(timeout);
  }
}

export function namesServiceBinding(service: NamesService): NamesServiceBinding {
  return {
    id: service.id,
    canonicalOrigin: service.canonicalOrigin,
    apiVersion: service.apiVersion,
    managedZone: service.managedZone,
  };
}

export function validateManagedName(service: NamesService, name: string, fqdn: string, wildcardFqdn?: string): void {
  const canonicalName = name.toLowerCase();
  const expected = `${canonicalName}.${service.managedZone}`;
  if (fqdn.toLowerCase().replace(/\.$/, '') !== expected) throw new Error('youeye_names_service_zone_mismatch');
  if (wildcardFqdn && wildcardFqdn.toLowerCase().replace(/\.$/, '') !== `*.${expected}`) {
    throw new Error('youeye_names_service_zone_mismatch');
  }
}

export function resetNamesServiceCache(): void {
  cached = null;
}
