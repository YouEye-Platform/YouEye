import crypto from 'node:crypto';

const PEM_CERTIFICATE = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

export interface ValidatedCertificate {
  certificateChain: string;
  /** Local X.509 leaf DER SHA-256, lowercase hexadecimal. */
  fingerprint: string;
  /** Broker certificate identity: SHA-256 of the first PEM block, Base64URL. */
  brokerFingerprint: string;
  issuedAt: string;
  expiresAt: string;
  domains: [string, string];
}

/** Compare broker and X.509 timestamps by instant, not ISO formatting style. */
export function sameCertificateInstant(first: string, second: string): boolean {
  const firstMs = Date.parse(first);
  const secondMs = Date.parse(second);
  return !Number.isNaN(firstMs) && !Number.isNaN(secondMs) && firstMs === secondMs;
}

function normaliseDnsName(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, '');
}

function certificateDnsNames(certificate: crypto.X509Certificate): string[] {
  const value = certificate.subjectAltName;
  if (!value) return [];
  return value
    .split(/,\s*/)
    .filter((entry) => entry.startsWith('DNS:'))
    .map((entry) => normaliseDnsName(entry.slice(4)));
}

/**
 * Prove that returned or imported material belongs to this exact name and key.
 * The chain links are cryptographically checked; the platform trust store is
 * deliberately not used because the broker can return either supported CA.
 */
export function validateCertificateMaterial(input: {
  certificateChain: string;
  privateKeyPem: string;
  fqdn: string;
  minimumRemainingMs?: number;
  allowExpired?: boolean;
}): ValidatedCertificate {
  if (Buffer.byteLength(input.certificateChain) > 192 * 1024) {
    throw new Error('youeye_names_certificate_chain_too_large');
  }
  const blocks = input.certificateChain.match(PEM_CERTIFICATE) || [];
  if (blocks.length === 0 || blocks.join('\n').replace(/\s/g, '') !== input.certificateChain.replace(/\s/g, '')) {
    throw new Error('youeye_names_certificate_chain_invalid');
  }

  let certificates: crypto.X509Certificate[];
  let privateKey: crypto.KeyObject;
  try {
    certificates = blocks.map((block) => new crypto.X509Certificate(block));
    privateKey = crypto.createPrivateKey(input.privateKeyPem);
  } catch {
    throw new Error('youeye_names_certificate_material_invalid');
  }

  const leaf = certificates[0];
  if (!leaf.checkPrivateKey(privateKey)) {
    throw new Error('youeye_names_certificate_key_mismatch');
  }
  const fqdn = normaliseDnsName(input.fqdn);
  const wildcard = `*.${fqdn}`;
  if (!leaf.checkHost(fqdn) || !leaf.checkHost(`test.${fqdn}`)) {
    throw new Error('youeye_names_certificate_hostname_mismatch');
  }
  const dnsNames = certificateDnsNames(leaf);
  if (
    dnsNames.length !== 2 ||
    new Set(dnsNames).size !== 2 ||
    !dnsNames.includes(fqdn) ||
    !dnsNames.includes(wildcard)
  ) {
    throw new Error('youeye_names_certificate_sans_invalid');
  }

  for (let index = 0; index < certificates.length - 1; index += 1) {
    const certificate = certificates[index];
    const issuer = certificates[index + 1];
    if (!certificate.checkIssued(issuer) || !certificate.verify(issuer.publicKey)) {
      throw new Error('youeye_names_certificate_chain_invalid');
    }
  }

  const issuedAtMs = Date.parse(leaf.validFrom);
  const expiresAtMs = Date.parse(leaf.validTo);
  const minimumRemainingMs = input.minimumRemainingMs ?? 0;
  if (
    Number.isNaN(issuedAtMs) ||
    Number.isNaN(expiresAtMs) ||
    issuedAtMs > Date.now() + 5 * 60_000 ||
    (!input.allowExpired && expiresAtMs - Date.now() <= minimumRemainingMs)
  ) {
    throw new Error('youeye_names_certificate_time_invalid');
  }

  return {
    certificateChain: `${blocks.join('\n').trim()}\n`,
    fingerprint: leaf.fingerprint256.replaceAll(':', '').toLowerCase(),
    brokerFingerprint: crypto.createHash('sha256').update(blocks[0]!).digest('base64url'),
    issuedAt: new Date(issuedAtMs).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
    domains: [fqdn, wildcard],
  };
}
