/**
 * TLS Certificate Storage
 *
 * Public certificates are stored in restricted host-persistent PEM files.
 * Private key material is encrypted with AES-256-GCM using a key derived from
 * the deployment secret and read back before the settings point at the file.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { settingsService } from '@/lib/settings';
import {
  decryptTLSSecret,
  encryptTLSSecret,
  isEncryptedTLSSecret,
} from './secret-crypto';

export interface StoredCert {
  mode: 'acme' | 'manual' | 'internal';
  certPem: string;
  keyPem: string;
  issuer: string;
  domains: string[];
  expiresAt: string;
  issuedAt: string;
}

const TLS_DIR = process.env.YOUEYE_TLS_SECRET_DIR || '/var/lib/youeye/config/tls';
const DEPLOY_SECRET_FILE =
  process.env.YOUEYE_DEPLOY_SECRET_FILE || '/var/lib/youeye/control/.deploy_secret';
const DEFAULT_ACCOUNT_KEY_FILE = join(TLS_DIR, 'acme-account-key.enc');
const DEFAULT_CERT_FILE = join(TLS_DIR, 'external-cert.pem');
const DEFAULT_KEY_FILE = join(TLS_DIR, 'external-key.enc');

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function looksLikePem(value: string, label?: string): boolean {
  if (!value.includes('-----BEGIN ') || !value.includes('-----END ')) return false;
  if (!label) return true;
  if (label === 'PRIVATE KEY') {
    return /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value);
  }
  return value.includes(`-----BEGIN ${label}`);
}

function readPemFile(path: string, label?: string): string | null {
  if (!existsSync(path)) return null;
  const pem = readFileSync(path, 'utf8').trim();
  if (!looksLikePem(pem, label)) {
    throw new Error(`invalid PEM data in ${path}`);
  }
  return pem;
}

function readDeploySecret(): Buffer {
  let secret: Buffer;
  try {
    secret = readFileSync(DEPLOY_SECRET_FILE);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`cannot read TLS encryption key source at ${DEPLOY_SECRET_FILE}: ${reason}`);
  }
  if (secret.length === 0) {
    throw new Error(`TLS encryption key source is empty at ${DEPLOY_SECRET_FILE}`);
  }
  return secret;
}

function readPrivateKeyFile(path: string): string | null {
  if (!existsSync(path)) return null;
  const stored = readFileSync(path, 'utf8').trim();
  if (!isEncryptedTLSSecret(stored)) {
    throw new Error(`unrecognised encrypted TLS key format in ${path}`);
  }
  const pem = decryptTLSSecret(stored, readDeploySecret()).trim();
  if (!looksLikePem(pem, 'PRIVATE KEY')) {
    throw new Error(`decrypted TLS key is not PEM in ${path}`);
  }
  return pem;
}

function ensureSecretDir(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
}

function writePublicCertFile(path: string, value: string): void {
  ensureSecretDir(path);
  writeFileSync(path, `${value.trim()}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function writeEncryptedPrivateKeyFile(path: string, value: string): void {
  if (!looksLikePem(value, 'PRIVATE KEY')) {
    throw new Error('TLS private key is not PEM');
  }
  ensureSecretDir(path);
  const encrypted = encryptTLSSecret(value.trim(), readDeploySecret());
  writeFileSync(path, `${encrypted}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  if (readPrivateKeyFile(path) !== value.trim()) {
    throw new Error(`encrypted TLS key readback failed for ${path}`);
  }
}

function parseDomains(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((d): d is string => typeof d === 'string');
  try {
    const parsed = JSON.parse(asString(raw) || '[]');
    return Array.isArray(parsed) ? parsed.filter((d): d is string => typeof d === 'string') : [];
  } catch {
    return [];
  }
}

function certFromRaw(raw: Record<string, unknown>, certPem: string, keyPem: string): StoredCert | null {
  const mode = asString(raw.tls_mode);
  if (mode !== 'acme' && mode !== 'manual') return null;
  if (!looksLikePem(certPem, 'CERTIFICATE') || !looksLikePem(keyPem, 'PRIVATE KEY')) return null;
  return {
    mode,
    certPem,
    keyPem,
    issuer: asString(raw.tls_cert_issuer) || 'unknown',
    domains: parseDomains(raw.tls_cert_domains),
    expiresAt: asString(raw.tls_cert_expires_at),
    issuedAt: asString(raw.tls_cert_issued_at),
  };
}

class TLSStorage {
  async getAccountKey(): Promise<string | null> {
    try {
      const raw = await settingsService.getRaw() as Record<string, unknown>;
      return readPrivateKeyFile(asString(raw.tls_acme_account_key_file) || DEFAULT_ACCOUNT_KEY_FILE);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`failed to load ACME account key: ${reason}`);
    }
  }

  async setAccountKey(keyPem: string): Promise<void> {
    writeEncryptedPrivateKeyFile(DEFAULT_ACCOUNT_KEY_FILE, keyPem);
    await settingsService.setRaw({ tls_acme_account_key_file: DEFAULT_ACCOUNT_KEY_FILE });
  }

  async storeCert(cert: StoredCert): Promise<void> {
    this.writeCertFiles(DEFAULT_CERT_FILE, DEFAULT_KEY_FILE, cert.certPem, cert.keyPem);
    await settingsService.setRaw({
      tls_mode: cert.mode,
      tls_cert_file: DEFAULT_CERT_FILE,
      tls_key_file: DEFAULT_KEY_FILE,
      tls_cert_issuer: cert.issuer,
      tls_cert_domains: JSON.stringify(cert.domains),
      tls_cert_expires_at: cert.expiresAt,
      tls_cert_issued_at: cert.issuedAt,
    });
  }

  async getCert(): Promise<StoredCert | null> {
    try {
      const raw = await settingsService.getRaw() as Record<string, unknown>;
      const mode = asString(raw.tls_mode);
      if (!mode || mode === 'internal') return null;
      const certPem = readPemFile(asString(raw.tls_cert_file) || DEFAULT_CERT_FILE, 'CERTIFICATE');
      const keyPem = readPrivateKeyFile(asString(raw.tls_key_file) || DEFAULT_KEY_FILE);
      if (!certPem || !keyPem) return null;
      return certFromRaw(raw, certPem, keyPem);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`failed to load TLS certificate: ${reason}`);
    }
  }

  async getMode(): Promise<'internal' | 'acme' | 'manual'> {
    try {
      const raw = await settingsService.getRaw() as Record<string, unknown>;
      const mode = raw.tls_mode as string;
      if (mode === 'acme' || mode === 'manual') return mode;
    } catch { /* settings unavailable: use the internal certificate mode */ }
    return 'internal';
  }

  async revertToInternal(): Promise<void> {
    await settingsService.setRaw({
      tls_mode: 'internal',
      tls_cert_file: '',
      tls_key_file: '',
      tls_cert_issuer: '',
      tls_cert_domains: '[]',
      tls_cert_expires_at: '',
      tls_cert_issued_at: '',
    });
  }

  private writeCertFiles(certFile: string, keyFile: string, certPem: string, keyPem: string): void {
    if (!looksLikePem(certPem, 'CERTIFICATE')) throw new Error('certificate is not PEM');
    writePublicCertFile(certFile, certPem);
    writeEncryptedPrivateKeyFile(keyFile, keyPem);
    if (readPemFile(certFile, 'CERTIFICATE') !== certPem.trim()) {
      throw new Error(`certificate readback failed for ${certFile}`);
    }
  }
}

export const tlsStorage = new TLSStorage();
