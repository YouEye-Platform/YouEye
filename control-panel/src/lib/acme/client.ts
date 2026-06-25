/**
 * ACME Client for Let's Encrypt DNS-01 Challenges
 *
 * Handles the manual DNS-01 flow:
 * 1. Create order for domain + wildcard
 * 2. Return DNS TXT records the user must create
 * 3. Verify challenges once user confirms records are in place
 * 4. Finalize order and retrieve the certificate
 *
 * Uses the step-by-step API (not auto()) because the user
 * must manually create DNS records between steps.
 */

import * as acme from 'acme-client';
import dns from 'dns';
import { tlsStorage } from './storage';
import { acmeTxtName } from '@/lib/dns-providers/domain';
import type { DnsProviderClient, ZoneRef } from '@/lib/dns-providers/types';

// ── Intercept ACME 429 rate limits ──────────────────────────
// The acme-client library silently retries on 429, sleeping for
// the full Retry-After value (can be 75,000+ seconds). We intercept
// 429 responses and throw immediately with an actionable message.
acme.axios.interceptors.response.use(undefined, (error: any) => {
  if (error?.response?.status === 429) {
    const retryAfter = parseInt(error.response.headers?.['retry-after'] || '0', 10);
    const detail = error.response.data?.detail || 'Too many requests';

    let retryMsg = '';
    if (retryAfter > 0) {
      const retryDate = new Date(Date.now() + retryAfter * 1000);
      retryMsg = ` Try again after ${retryDate.toISOString().replace('T', ' ').replace(/\.\d+Z/, ' UTC')}.`;
    }

    return Promise.reject(new Error(
      `Rate limited by Let's Encrypt: ${detail}.${retryMsg} You can use a self-signed certificate for now.`
    ));
  }
  return Promise.reject(error);
});

/** Challenge info returned to the UI */
export interface DnsChallengeRecord {
  domain: string;
  txtName: string;
  txtValue: string;
}

/** Challenge object type (from rfc8555 sub-types) */
type AcmeChallenge = acme.Authorization['challenges'][number];

/** Active order state (held in memory during the flow) */
interface ActiveOrder {
  order: acme.Order;
  authorizations: acme.Authorization[];
  challenges: Array<{
    authz: acme.Authorization;
    challenge: AcmeChallenge;
    keyAuth: string;
  }>;
  privateKey: Buffer;
  domains: string[];
  createdAt: number;
}

/** In-memory store for active orders (short-lived, ~30 min max) */
const activeOrders = new Map<string, ActiveOrder>();

/** Order TTL — 30 minutes */
const ORDER_TTL_MS = 30 * 60 * 1000;

/** Clean up expired orders */
function cleanExpiredOrders(): void {
  const now = Date.now();
  for (const [id, order] of activeOrders) {
    if (now - order.createdAt > ORDER_TTL_MS) {
      activeOrders.delete(id);
    }
  }
}

/** Get or create ACME client with account */
async function getClient(): Promise<acme.Client> {
  const storedKey = await tlsStorage.getAccountKey();

  let accountKey: Buffer;
  if (storedKey) {
    accountKey = Buffer.from(storedKey);
  } else {
    accountKey = await acme.crypto.createPrivateKey();
    await tlsStorage.setAccountKey(accountKey.toString());
  }

  const client = new acme.Client({
    directoryUrl: acme.directory.letsencrypt.production,
    accountKey,
  });

  // Ensure account exists
  await client.createAccount({
    termsOfServiceAgreed: true,
  });

  return client;
}

/**
 * Start a certificate order.
 * Returns the DNS TXT records the user needs to create.
 */
export async function startOrder(
  domain: string,
  includeWildcard: boolean = true,
): Promise<{ orderId: string; challenges: DnsChallengeRecord[] }> {
  cleanExpiredOrders();

  const client = await getClient();

  // Build identifiers
  const identifiers: Array<{ type: 'dns'; value: string }> = [
    { type: 'dns', value: domain },
  ];
  if (includeWildcard) {
    identifiers.push({ type: 'dns', value: `*.${domain}` });
  }

  const domains = identifiers.map((i) => i.value);

  // Create order
  const order = await client.createOrder({ identifiers });

  // Get authorizations
  const authorizations = await client.getAuthorizations(order);

  // Extract dns-01 challenges
  const challengeDetails: ActiveOrder['challenges'] = [];
  const dnsRecords: DnsChallengeRecord[] = [];

  for (const authz of authorizations) {
    const challenge = authz.challenges.find(
      (c: AcmeChallenge) => c.type === 'dns-01',
    );
    if (!challenge) {
      throw new Error(
        `No dns-01 challenge available for ${authz.identifier.value}`,
      );
    }

    const keyAuth = await client.getChallengeKeyAuthorization(challenge);

    challengeDetails.push({ authz, challenge, keyAuth });

    dnsRecords.push({
      domain: authz.identifier.value,
      txtName: `_acme-challenge.${authz.identifier.value.replace(/^\*\./, '')}`,
      txtValue: keyAuth,
    });
  }

  // Generate certificate private key
  const privateKey = await acme.crypto.createPrivateKey();

  // Store active order
  const orderId = `order-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  activeOrders.set(orderId, {
    order,
    authorizations,
    challenges: challengeDetails,
    privateKey,
    domains,
    createdAt: Date.now(),
  });

  return { orderId, challenges: dnsRecords };
}

/**
 * Verify DNS records and complete the ACME challenge.
 * Returns the issued certificate and private key.
 */
export async function verifyAndFinalize(
  orderId: string,
): Promise<{
  certificate: string;
  privateKey: string;
  domains: string[];
  expiresAt: string;
}> {
  const activeOrder = activeOrders.get(orderId);
  if (!activeOrder) {
    throw new Error(
      'Order not found or expired. Please start a new certificate request.',
    );
  }

  const client = await getClient();

  // Complete each challenge
  for (const { authz, challenge, keyAuth } of activeOrder.challenges) {
    // Verify the DNS record is in place by querying authoritative
    // nameservers directly. This bypasses local resolver caches
    // (systemd-resolved, c-ares) that can hold stale negative responses
    // for minutes after TXT records are created.
    const domain = authz.identifier.value;
    const baseDomain = domain.replace(/^\*\./, '');
    const recordName = acmeTxtName(domain);

    try {
      const txtValues = await resolveViaAuthoritativeNs(recordName, baseDomain);
      if (!txtValues.includes(keyAuth)) {
        throw new Error('TXT value mismatch');
      }
    } catch {
      throw new Error(
        `DNS verification failed for ${domain}. ` +
          `Ensure TXT record ${recordName} is set to: ${keyAuth}`,
      );
    }

    // Tell Let's Encrypt to check
    await client.completeChallenge(challenge);
  }

  // Wait for challenges to be validated (status: "ready" or "valid")
  const readyOrder = await client.waitForValidStatus(activeOrder.order);
  // Preserve .url from the original order — waitForValidStatus returns the raw
  // ACME response body which does NOT include .url (it's added client-side by
  // createOrder). The second waitForValidStatus call below needs it.
  readyOrder.url = activeOrder.order.url;

  // Create CSR
  const [, csr] = await acme.crypto.createCsr({
    altNames: activeOrder.domains,
  }, activeOrder.privateKey);

  // Finalize order — skip if already "valid" (e.g. retry after prior finalization succeeded)
  if (readyOrder.status !== 'valid') {
    await client.finalizeOrder(readyOrder, csr);
  }

  // Wait for order to reach "valid" with certificate URL populated
  const validOrder = await client.waitForValidStatus(readyOrder);

  // Get certificate
  const certificate = await client.getCertificate(validOrder);

  // Parse expiry from certificate
  const expiresAt = parseCertExpiry(certificate);

  // Store certificate
  await tlsStorage.storeCert({
    mode: 'acme',
    certPem: certificate,
    keyPem: activeOrder.privateKey.toString(),
    issuer: "Let's Encrypt",
    domains: activeOrder.domains,
    expiresAt,
    issuedAt: new Date().toISOString(),
  });

  // Clean up active order
  activeOrders.delete(orderId);

  return {
    certificate,
    privateKey: activeOrder.privateKey.toString(),
    domains: activeOrder.domains,
    expiresAt,
  };
}

export async function issueCertificateWithDnsProvider(
  domain: string,
  provider: DnsProviderClient,
  zone: ZoneRef,
  includeWildcard = true,
): Promise<{
  certificate: string;
  privateKey: string;
  domains: string[];
  expiresAt: string;
}> {
  const client = await getClient();
  const identifiers: Array<{ type: 'dns'; value: string }> = [{ type: 'dns', value: domain }];
  if (includeWildcard) identifiers.push({ type: 'dns', value: `*.${domain}` });
  const domains = identifiers.map((identifier) => identifier.value);
  const order = await client.createOrder({ identifiers });
  const authorizations = await client.getAuthorizations(order);
  const createdTxtRecords: Array<{ name: string; value: string; recordId?: string }> = [];
  const privateKey = await acme.crypto.createPrivateKey();

  try {
    for (const authz of authorizations) {
      const challenge = authz.challenges.find((c: AcmeChallenge) => c.type === 'dns-01');
      if (!challenge) {
        throw new Error(`No dns-01 challenge available for ${authz.identifier.value}`);
      }

      const keyAuth = await client.getChallengeKeyAuthorization(challenge);
      const recordName = acmeTxtName(authz.identifier.value);
      const change = await provider.ensureTxtRecord({ zone, name: recordName, value: keyAuth, ttl: 60 });
      createdTxtRecords.push({ name: recordName, value: keyAuth, recordId: change.recordId });

      await waitForTxtValue(recordName, keyAuth);
      await client.completeChallenge(challenge);
    }

    const readyOrder = await client.waitForValidStatus(order);
    readyOrder.url = order.url;

    const [, csr] = await acme.crypto.createCsr({ altNames: domains }, privateKey);
    if (readyOrder.status !== 'valid') {
      await client.finalizeOrder(readyOrder, csr);
    }

    const validOrder = await client.waitForValidStatus(readyOrder);
    const certificate = await client.getCertificate(validOrder);
    const expiresAt = parseCertExpiry(certificate);

    await tlsStorage.storeCert({
      mode: 'acme',
      certPem: certificate,
      keyPem: privateKey.toString(),
      issuer: "Let's Encrypt",
      domains,
      expiresAt,
      issuedAt: new Date().toISOString(),
    });

    return {
      certificate,
      privateKey: privateKey.toString(),
      domains,
      expiresAt,
    };
  } finally {
    await Promise.allSettled(
      createdTxtRecords.map((record) =>
        provider.deleteTxtRecord({ zone, name: record.name, value: record.value, recordId: record.recordId }),
      ),
    );
  }
}

/**
 * Get the active order status (for polling)
 */
export function getOrderStatus(orderId: string): {
  exists: boolean;
  domains?: string[];
  age?: number;
} {
  const order = activeOrders.get(orderId);
  if (!order) return { exists: false };
  return {
    exists: true,
    domains: order.domains,
    age: Date.now() - order.createdAt,
  };
}

/**
 * Query authoritative nameservers directly for TXT records.
 * Bypasses local DNS caches that may hold stale negative responses.
 */
async function resolveViaAuthoritativeNs(
  recordName: string,
  baseDomain: string,
): Promise<string[]> {
  const nsRecords = await resolveAuthoritativeNs(recordName, baseDomain);
  const nsIpArrays = await Promise.all(
    nsRecords.map((ns) => dns.promises.resolve4(ns)),
  );
  const nsIps = nsIpArrays.flat().filter(Boolean);

  if (!nsIps.length) {
    throw new Error(`No authoritative nameservers found for ${baseDomain}`);
  }

  // Query authoritative NS directly
  const resolver = new dns.Resolver();
  resolver.setServers(nsIps);

  const txtRecords = await new Promise<string[][]>((resolve, reject) => {
    resolver.resolveTxt(recordName, (err, records) =>
      err ? reject(err) : resolve(records),
    );
  });

  return txtRecords.flat();
}

async function resolveAuthoritativeNs(recordName: string, fallbackBaseDomain: string): Promise<string[]> {
  const labels = recordName.replace(/\.$/, '').split('.');
  for (let i = 0; i <= labels.length - 2; i += 1) {
    const candidate = labels.slice(i).join('.');
    try {
      const records = await dns.promises.resolveNs(candidate);
      if (records.length > 0) return records;
    } catch {
      // Try the next parent name.
    }
  }
  return dns.promises.resolveNs(fallbackBaseDomain);
}

async function waitForTxtValue(recordName: string, expectedValue: string): Promise<void> {
  const deadline = Date.now() + 120_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const txtValues = await resolveViaAuthoritativeNs(recordName, recordName);
      if (txtValues.includes(expectedValue)) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  throw new Error(`DNS validation record did not propagate for ${recordName}${lastError instanceof Error ? `: ${lastError.message}` : ''}`);
}

/**
 * Parse certificate expiry from PEM using acme-client's crypto module.
 * Falls back to 90 days from now if parsing fails.
 */
function parseCertExpiry(certPem: string): string {
  try {
    const info = acme.crypto.readCertificateInfo(certPem);
    return info.notAfter.toISOString();
  } catch {
    // Fallback: Let's Encrypt certs are valid for 90 days
    const expiry = new Date();
    expiry.setDate(expiry.getDate() + 90);
    return expiry.toISOString();
  }
}
