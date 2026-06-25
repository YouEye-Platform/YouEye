/**
 * YouEye Names — broker client
 *
 * Talks to the public broker API (default https://names.youeye.me) using the
 * install identity for signed requests. This is the local-server side of the
 * protocol Stefa proved in `YouEye-Names/src/cli/e2e-client.ts`.
 *
 * The broker brokers names, DNS, and certificates only — it never sees the TLS
 * private key (we send a CSR, it returns a chain).
 */
import crypto from 'node:crypto';
import {
  getInstallIdentity,
  signPayload,
  type InstallIdentity,
} from './identity';

const BASE = (process.env.YOUEYE_NAMES_URL || 'https://names.youeye.me').replace(
  /\/+$/,
  '',
);

/** The managed apex the broker leases names under. */
export const NAMES_ZONE = process.env.YOUEYE_NAMES_ZONE || 'youeye.me';

export interface NamePreview {
  name: string;
  fqdn: string;
  wildcardFqdn: string;
  available: boolean;
}

export interface CurrentCertificate {
  certificateChain: string;
  expiresAt: string;
}

let registered = false;

/** Register the install public key with the broker (idempotent, once per process). */
async function ensureRegistered(identity: InstallIdentity): Promise<void> {
  if (registered) return;
  const res = await fetch(`${BASE}/v1/installs/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ publicKey: identity.publicKeyRaw }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `register failed (${res.status}): ${text.slice(0, 200) || 'no body'}`,
    );
  }
  registered = true;
}

/** Sign + send a broker request per the canonical scheme. */
async function signedFetch(
  method: string,
  urlPath: string,
  body?: unknown,
): Promise<Response> {
  const identity = await getInstallIdentity();
  await ensureRegistered(identity);

  const bodyStr = body === undefined ? '' : JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(16).toString('hex');
  const bodyHash = crypto.createHash('sha256').update(bodyStr).digest('hex');
  // canonical = METHOD \n path \n timestamp \n nonce \n sha256hex(body)
  const payload = [method.toUpperCase(), urlPath, timestamp, nonce, bodyHash].join(
    '\n',
  );
  const signature = signPayload(identity, payload);

  return fetch(`${BASE}${urlPath}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-youeye-install-fingerprint': identity.fingerprint,
      'x-youeye-timestamp': timestamp,
      'x-youeye-nonce': nonce,
      'x-youeye-signature': signature,
    },
    body: method.toUpperCase() === 'GET' ? undefined : bodyStr,
  });
}

async function parse(res: Response): Promise<Record<string, unknown>> {
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error((data.error as string) || `broker error (${res.status})`);
  }
  return data;
}

/** Generated name options. Non-committing: no lease, DNS, or certificate work. */
export async function previewNames(count: number): Promise<NamePreview[]> {
  const data = await parse(await signedFetch('POST', '/v1/leases/preview', { count }));
  return (data.previews as NamePreview[]) || [];
}

/** Availability check for one specific name. Also non-committing. */
export async function previewName(name: string): Promise<NamePreview | null> {
  const data = await parse(await signedFetch('POST', '/v1/leases/preview', { name }));
  const previews = (data.previews as NamePreview[]) || [];
  return previews[0] || null;
}

/** Commit a lease for `name`, pointing DNS at `currentIp` (private/VPN only). */
export async function claimName(
  name: string,
  currentIp: string,
): Promise<Record<string, unknown>> {
  return parse(await signedFetch('POST', '/v1/leases/claim', { name, currentIp }));
}

/** Submit a CSR (SANs name.zone + *.name.zone) to queue ACME issuance. */
export async function requestCertificate(
  name: string,
  csrPem: string,
): Promise<void> {
  await parse(
    await signedFetch(
      'POST',
      `/v1/leases/${encodeURIComponent(name)}/certificates/request`,
      { csrPem },
    ),
  );
}

/** Fetch the issued certificate chain, or null while the worker is still issuing. */
export async function getCurrentCertificate(
  name: string,
): Promise<CurrentCertificate | null> {
  const res = await signedFetch(
    'GET',
    `/v1/leases/${encodeURIComponent(name)}/certificates/current`,
  );
  if (res.status === 404) return null;
  const data = await parse(res);
  const cert = (data.certificate as Record<string, unknown>) || data;
  const chain = cert?.certificateChain as string | undefined;
  if (!chain) return null;
  return { certificateChain: chain, expiresAt: (cert.expiresAt as string) || '' };
}

/** Routine IP change — updates DNS only, never reissues a certificate. */
export async function updateIp(name: string, ip: string): Promise<void> {
  await parse(
    await signedFetch('POST', `/v1/leases/${encodeURIComponent(name)}/ip`, { ip }),
  );
}
