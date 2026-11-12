import { X509Certificate, createPrivateKey } from 'node:crypto';

const PEM = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;
const DNS = /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Proves key/name/time/chain consistency; browser trust is checked separately. */
export function validateUploadedCertificate(input: {
  certificate: string; privateKey: string; domains: unknown; now?: number;
}) {
  if (Buffer.byteLength(input.certificate) > 192 * 1024 || Buffer.byteLength(input.privateKey) > 32 * 1024) {
    throw new Error('Certificate or private key is too large.');
  }
  if (!Array.isArray(input.domains) || input.domains.length === 0 || input.domains.length > 64
    || input.domains.some(name => typeof name !== 'string' || name.length > 253 || !DNS.test(name))) {
    throw new Error('Valid certificate DNS names are required.');
  }
  const domains = [...new Set(input.domains as string[])];
  const blocks = input.certificate.match(PEM) ?? [];
  if (!blocks.length || blocks.join('').replace(/\s/g, '') !== input.certificate.replace(/\s/g, '')) {
    throw new Error('Invalid certificate chain.');
  }
  let certificates: X509Certificate[];
  try { certificates = blocks.map(block => new X509Certificate(block)); }
  catch { throw new Error('Invalid certificate chain.'); }
  const leaf = certificates[0];
  try {
    if (!leaf.checkPrivateKey(createPrivateKey(input.privateKey))) throw new Error();
  } catch { throw new Error('The certificate and private key do not match.'); }
  const now = input.now ?? Date.now();
  for (let index = 0; index < certificates.length; index++) {
    const certificate = certificates[index];
    if (!Number.isFinite(Date.parse(certificate.validFrom)) || !Number.isFinite(Date.parse(certificate.validTo))
      || Date.parse(certificate.validFrom) > now || Date.parse(certificate.validTo) <= now) {
      throw new Error('The certificate chain is expired or not yet valid.');
    }
    const issuer = certificates[index + 1];
    if (issuer && (!issuer.ca || !certificate.checkIssued(issuer) || !certificate.verify(issuer.publicKey))) {
      throw new Error('The certificate chain has an invalid issuer or signature.');
    }
  }
  const dnsNames = (leaf.subjectAltName ?? '').split(/,\s*/).filter(value => value.startsWith('DNS:')).map(value => value.slice(4).toLowerCase());
  for (const name of domains) {
    if (!dnsNames.length || (name.startsWith('*.') ? !dnsNames.includes(name) : !leaf.checkHost(name, { subject: 'never' }))) {
      throw new Error(`The certificate does not cover ${name}.`);
    }
  }
  return {
    certificate: `${blocks.join('\n')}\n`, privateKey: input.privateKey.trim(), domains,
    issuedAt: new Date(leaf.validFrom).toISOString(), expiresAt: new Date(leaf.validTo).toISOString(),
  };
}
