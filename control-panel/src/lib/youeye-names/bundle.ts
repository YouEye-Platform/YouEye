/**
 * YouEye Names — reuse bundle
 *
 * A bundle is everything needed to resume a leased name WITHOUT a fresh
 * Let's Encrypt issuance: the install-identity keypair (authorizes the lease),
 * the local TLS key, the certificate chain, and the lease name. The broker
 * holds neither private key, so carrying these across (re)installs lets a box
 * reuse its address + cert. It is a CREDENTIAL — written 0600, never logged.
 *
 * Staged-import path: the installer drops a bundle at IMPORT_FILE before the
 * setup wizard runs; setup detects it and reuses instead of claiming + issuing.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tlsStorage } from '@/lib/acme/storage';
import { NAMES_ZONE } from './client';
import { IDENTITY_DATA_DIR, IDENTITY_FILE_PATH, resetIdentityCache } from './identity';

const IMPORT_FILE = path.join(IDENTITY_DATA_DIR, 'import-bundle.json');

export interface NamesBundle {
  name: string;
  identity: { privateKeyPem: string; publicKeyRaw: string; fingerprint: string };
  tls: { keyPem: string; certPem: string };
  expiresAt: string;
}

function nameFromDomains(domains: string[]): string {
  const apex = domains.find((d) => !d.startsWith('*.')) || domains[0] || '';
  const suffix = `.${NAMES_ZONE}`;
  return apex.endsWith(suffix) ? apex.slice(0, -suffix.length) : '';
}

/** Build a reuse bundle from the current install identity + stored cert. */
export async function exportBundle(): Promise<NamesBundle | null> {
  let identity: NamesBundle['identity'];
  try {
    identity = JSON.parse(await fs.readFile(IDENTITY_FILE_PATH, 'utf8'));
  } catch {
    return null;
  }
  const cert = await tlsStorage.getCert();
  // Only YouEye Names certs (installed as 'manual') are reusable this way.
  if (!cert || cert.mode !== 'manual') return null;
  const name = nameFromDomains(cert.domains);
  if (!name) return null;
  return {
    name,
    identity: {
      privateKeyPem: identity.privateKeyPem,
      publicKeyRaw: identity.publicKeyRaw,
      fingerprint: identity.fingerprint,
    },
    tls: { keyPem: cert.keyPem, certPem: cert.certPem },
    expiresAt: cert.expiresAt || '',
  };
}

/** Read a staged import bundle (placed by the installer), or null. */
export async function getStagedBundle(): Promise<NamesBundle | null> {
  try {
    const b = JSON.parse(await fs.readFile(IMPORT_FILE, 'utf8')) as NamesBundle;
    if (!b?.name || !b.identity?.privateKeyPem || !b.tls?.certPem) return null;
    return b;
  } catch {
    return null;
  }
}

/** Remove the staged bundle once consumed. */
export async function consumeStagedBundle(): Promise<void> {
  try {
    await fs.unlink(IMPORT_FILE);
  } catch {
    /* already gone */
  }
}

/** Install the bundle's identity so subsequent broker calls sign as it. */
export async function applyBundleIdentity(bundle: NamesBundle): Promise<void> {
  await fs.mkdir(IDENTITY_DATA_DIR, { recursive: true });
  await fs.writeFile(IDENTITY_FILE_PATH, JSON.stringify(bundle.identity, null, 2), {
    mode: 0o600,
  });
  resetIdentityCache();
}

/** True if the bundle's cert is comfortably valid (not within 7 days of expiry). */
export function bundleCertStillValid(bundle: NamesBundle): boolean {
  if (!bundle.expiresAt) return false;
  const expiry = Date.parse(bundle.expiresAt);
  if (Number.isNaN(expiry)) return false;
  return expiry - Date.now() > 7 * 24 * 60 * 60 * 1000;
}
