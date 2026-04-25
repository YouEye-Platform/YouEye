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
import { tlsStorage } from './storage';

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
    // Verify the DNS record is in place
    try {
      await client.verifyChallenge(authz, challenge);
    } catch (err) {
      const domain = authz.identifier.value;
      throw new Error(
        `DNS verification failed for ${domain}. ` +
          `Ensure TXT record _acme-challenge.${domain.replace(/^\*\./, '')} ` +
          `is set to: ${keyAuth}`,
      );
    }

    // Tell Let's Encrypt to check
    await client.completeChallenge(challenge);
  }

  // Wait for order to be ready
  const finalOrder = await client.waitForValidStatus(activeOrder.order);

  // Create CSR
  const [, csr] = await acme.crypto.createCsr({
    altNames: activeOrder.domains,
  }, activeOrder.privateKey);

  // Finalize order
  await client.finalizeOrder(finalOrder, csr);

  // Get certificate
  const certificate = await client.getCertificate(finalOrder);

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
