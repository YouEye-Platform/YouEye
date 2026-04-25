/**
 * TLS Certificate Storage
 *
 * Persists ACME account keys and issued certificates
 * using Spine's config API (youeye.yaml) via settingsService.
 *
 * PEM strings are stored as config values — they're small (~2KB each)
 * and this ensures they survive container recreation.
 */

import { settingsService } from '@/lib/settings';

export interface StoredCert {
  mode: 'acme' | 'manual' | 'internal';
  certPem: string;
  keyPem: string;
  issuer: string;
  domains: string[];
  expiresAt: string;
  issuedAt: string;
}

class TLSStorage {
  /** Get ACME account private key (PEM string) */
  async getAccountKey(): Promise<string | null> {
    try {
      const raw = await settingsService.getRaw();
      return (raw as Record<string, unknown>).tls_acme_account_key as string || null;
    } catch {
      return null;
    }
  }

  /** Store ACME account private key */
  async setAccountKey(keyPem: string): Promise<void> {
    await settingsService.setRaw({ tls_acme_account_key: keyPem });
  }

  /** Store a certificate (from ACME or manual upload) */
  async storeCert(cert: StoredCert): Promise<void> {
    await settingsService.setRaw({
      tls_mode: cert.mode,
      tls_cert_pem: cert.certPem,
      tls_key_pem: cert.keyPem,
      tls_cert_issuer: cert.issuer,
      tls_cert_domains: JSON.stringify(cert.domains),
      tls_cert_expires_at: cert.expiresAt,
      tls_cert_issued_at: cert.issuedAt,
    });
  }

  /** Get the stored certificate, or null if none */
  async getCert(): Promise<StoredCert | null> {
    try {
      const raw = await settingsService.getRaw() as Record<string, unknown>;
      const mode = raw.tls_mode as string;
      if (!mode || mode === 'internal') return null;

      const certPem = raw.tls_cert_pem as string;
      const keyPem = raw.tls_key_pem as string;
      if (!certPem || !keyPem) return null;

      let domains: string[] = [];
      try {
        domains = JSON.parse(raw.tls_cert_domains as string || '[]');
      } catch {
        domains = [];
      }

      return {
        mode: mode as StoredCert['mode'],
        certPem,
        keyPem,
        issuer: (raw.tls_cert_issuer as string) || 'unknown',
        domains,
        expiresAt: (raw.tls_cert_expires_at as string) || '',
        issuedAt: (raw.tls_cert_issued_at as string) || '',
      };
    } catch {
      return null;
    }
  }

  /** Get just the TLS mode without loading full cert */
  async getMode(): Promise<'internal' | 'acme' | 'manual'> {
    try {
      const raw = await settingsService.getRaw() as Record<string, unknown>;
      const mode = raw.tls_mode as string;
      if (mode === 'acme' || mode === 'manual') return mode;
    } catch { /* ignore */ }
    return 'internal';
  }

  /** Revert to self-signed (internal CA) mode */
  async revertToInternal(): Promise<void> {
    await settingsService.setRaw({
      tls_mode: 'internal',
      tls_cert_pem: '',
      tls_key_pem: '',
      tls_cert_issuer: '',
      tls_cert_domains: '[]',
      tls_cert_expires_at: '',
      tls_cert_issued_at: '',
    });
  }
}

export const tlsStorage = new TLSStorage();
