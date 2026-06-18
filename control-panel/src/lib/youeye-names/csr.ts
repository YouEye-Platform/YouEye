/**
 * YouEye Names — local TLS key + CSR generation
 *
 * The TLS private key is generated HERE and never leaves the server. We hand
 * the broker only the CSR; it returns a certificate chain. SANs are exactly
 * `<fqdn>` and `*.<fqdn>` (the broker rejects anything else), so one lease
 * covers the apex and every platform subdomain (control., id., dns., …).
 *
 * Uses acme-client's crypto (already a CP dependency) — same toolchain the
 * existing Let's Encrypt path uses.
 */
import * as acme from 'acme-client';

export interface GeneratedCsr {
  /** PEM private key — install into Caddy, never send to the broker. */
  keyPem: string;
  /** PEM CSR — send to the broker. */
  csrPem: string;
}

export async function generateCsr(fqdn: string): Promise<GeneratedCsr> {
  const [key, csr] = await acme.crypto.createCsr({
    commonName: fqdn,
    altNames: [fqdn, `*.${fqdn}`],
  });
  return { keyPem: key.toString(), csrPem: csr.toString() };
}
