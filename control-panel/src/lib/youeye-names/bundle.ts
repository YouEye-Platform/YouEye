/**
 * Versioned YouEye Names recovery bundle.
 *
 * A bundle contains two private keys and is therefore a credential. Imports
 * are size/mode bounded and fully validated before any persistent identity is
 * replaced. The final ui.bingo contract intentionally accepts only schema v3.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { tlsStorage } from '@/lib/acme/storage';
import { validateCertificateMaterial } from './certificate';
import { resetBrokerRegistrationCache } from './client';
import {
  getStoredInstallIdentity,
  IDENTITY_DATA_DIR,
  validateStoredIdentity,
  writeInstallIdentityAtomic,
  type StoredInstallIdentity,
} from './identity';
import { readNamesLifecycleState } from './state';
import {
  configuredNamesServiceOrigin,
  expectedNamesServiceId,
} from './service';

const IMPORT_FILE = path.join(IDENTITY_DATA_DIR, 'import-bundle.json');
const MAX_BUNDLE_BYTES = 1024 * 1024;
const SAFE_CERT_REMAINING_MS = 7 * 24 * 60 * 60 * 1000;
const nameSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/);
const identitySchema = z
  .object({
    schema: z.literal(1).optional(),
    privateKeyPem: z.string().min(64).max(16 * 1024),
    publicKeyRaw: z.string().min(40).max(80),
    fingerprint: z.string().min(40).max(80),
  })
  .strict();
const tlsSchema = z
  .object({
    keyPem: z.string().min(64).max(64 * 1024),
    certPem: z.string().min(64).max(192 * 1024),
  })
  .strict();
const serviceSchema = z.object({
  id: z.string().min(3).max(64),
  canonicalOrigin: z.string().url(),
  apiVersion: z.literal('v1'),
  managedZone: z.string().min(1).max(253),
}).strict();
const v3Schema = z
  .object({
    schemaVersion: z.literal(3),
    exportedAt: z.string().datetime({ offset: true }),
    service: serviceSchema,
    name: nameSchema,
    fqdn: z.string().min(1).max(253),
    identity: identitySchema,
    tls: tlsSchema,
    certificate: z
      .object({
        fingerprint: z.string().min(32).max(256),
        provider: z.enum(['letsencrypt', 'google-public-ca']).nullable(),
        issuedAt: z.string().datetime({ offset: true }),
        expiresAt: z.string().datetime({ offset: true }),
      })
      .strict(),
    consent: z
      .object({
        termsVersion: z.string().min(1).max(64).nullable(),
        certificateTransparencyAcceptedAt: z.string().datetime({ offset: true }).nullable(),
      })
      .strict(),
  })
  .strict();
export type NamesBundle = z.infer<typeof v3Schema>;

/** Parse and cryptographically validate the final service-bound bundle. */
export function parseNamesBundle(value: unknown): NamesBundle {
  const wrapped =
    value && typeof value === 'object' && 'bundle' in value
      ? (value as { bundle?: unknown }).bundle
      : value;
  const result = v3Schema.safeParse(wrapped);
  if (!result.success) throw new Error('youeye_names_bundle_format_invalid');
  const candidate = result.data;
  if (
    candidate.service.id !== expectedNamesServiceId() ||
    candidate.service.canonicalOrigin !== configuredNamesServiceOrigin()
  ) throw new Error('youeye_names_bundle_service_mismatch');
  const validatedIdentity = validateStoredIdentity(candidate.identity).stored;
  const fqdn = candidate.fqdn.toLowerCase().replace(/\.$/, '');
  if (fqdn !== `${candidate.name}.${candidate.service.managedZone}`) {
    throw new Error('youeye_names_bundle_fqdn_invalid');
  }
  const certificate = validateCertificateMaterial({
    certificateChain: candidate.tls.certPem,
    privateKeyPem: candidate.tls.keyPem,
    fqdn,
    allowExpired: true,
  });

  if (
    candidate.certificate.fingerprint.toLowerCase().replaceAll(':', '') !== certificate.fingerprint ||
    candidate.certificate.issuedAt !== certificate.issuedAt ||
    candidate.certificate.expiresAt !== certificate.expiresAt
  ) {
    throw new Error('youeye_names_bundle_certificate_metadata_mismatch');
  }

  return {
    ...candidate,
    schemaVersion: 3,
    name: candidate.name,
    fqdn,
    identity: validatedIdentity as Required<StoredInstallIdentity>,
    tls: {
      keyPem: candidate.tls.keyPem.trim(),
      certPem: certificate.certificateChain,
    },
    certificate: {
      fingerprint: certificate.fingerprint,
      provider: candidate.certificate.provider,
      issuedAt: certificate.issuedAt,
      expiresAt: certificate.expiresAt,
    },
    consent: candidate.consent,
  };
}

/** Build a v3 recovery bundle from the validated local identity, lease and cert. */
export async function exportBundle(): Promise<NamesBundle | null> {
  let identity: StoredInstallIdentity;
  try {
    identity = await getStoredInstallIdentity();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const cert = await tlsStorage.getCert();
  if (!cert || cert.mode !== 'manual') return null;
  const lifecycle = await readNamesLifecycleState();
  if (!lifecycle || !lifecycle.certificate || !cert.domains.includes(lifecycle.fqdn)) return null;
  const { name, fqdn } = lifecycle;
  const certificate = validateCertificateMaterial({
    certificateChain: cert.certPem,
    privateKeyPem: cert.keyPem,
    fqdn,
  });
  return {
    schemaVersion: 3,
    exportedAt: new Date().toISOString(),
    service: lifecycle.service,
    name,
    fqdn,
    identity: validateStoredIdentity(identity).stored as Required<StoredInstallIdentity>,
    tls: { keyPem: cert.keyPem.trim(), certPem: certificate.certificateChain },
    certificate: {
      fingerprint: certificate.fingerprint,
      provider: lifecycle.certificate.provider,
      issuedAt: certificate.issuedAt,
      expiresAt: certificate.expiresAt,
    },
    consent: {
      termsVersion: lifecycle.termsVersion,
      certificateTransparencyAcceptedAt:
        lifecycle.certificateTransparencyAcceptedAt,
    },
  };
}

/** Read a protected staged bundle; malformed state is surfaced, never hidden. */
export async function getStagedBundle(): Promise<NamesBundle | null> {
  try {
    const stat = await fs.lstat(IMPORT_FILE);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('youeye_names_bundle_file_type_invalid');
    }
    if ((stat.mode & 0o777) !== 0o600) {
      throw new Error('youeye_names_bundle_file_permissions_invalid');
    }
    if (stat.size > MAX_BUNDLE_BYTES) {
      throw new Error('youeye_names_bundle_too_large');
    }
    const raw = await fs.readFile(IMPORT_FILE, 'utf8');
    return parseNamesBundle(JSON.parse(raw) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (error instanceof SyntaxError) {
      throw new Error('youeye_names_bundle_json_invalid');
    }
    throw error;
  }
}

export async function consumeStagedBundle(): Promise<void> {
  await fs.unlink(IMPORT_FILE).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
}

/** Persist the already validated imported authority as one atomic replacement. */
export async function applyBundleIdentity(bundle: NamesBundle): Promise<void> {
  const parsed = parseNamesBundle(bundle);
  await writeInstallIdentityAtomic(parsed.identity);
  resetBrokerRegistrationCache();
}

export function bundleCertStillValid(bundle: NamesBundle): boolean {
  try {
    const parsed = parseNamesBundle(bundle);
    validateCertificateMaterial({
      certificateChain: parsed.tls.certPem,
      privateKeyPem: parsed.tls.keyPem,
      fqdn: parsed.fqdn,
      minimumRemainingMs: SAFE_CERT_REMAINING_MS,
    });
    return true;
  } catch {
    return false;
  }
}

export const NAMES_IMPORT_FILE_PATH = IMPORT_FILE;
