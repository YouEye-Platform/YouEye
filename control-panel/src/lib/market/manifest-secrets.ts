/**
 * A manifest's secrets and credentials, as the install and the update write them.
 *
 * An update may add a secret (`secrets:` gains an entry, e.g. a new admin password) and change `credentials:`.
 * The updater generates each declared secret the installation lacks inside its update transaction, one journaled
 * step per secret (`generate-secret-<name>`), before the new configuration is rendered. A rollback, also one
 * resumed after a restart, deletes exactly the secrets those steps name: never a secret the app had before.
 */

import {
  generateHexToken, generatePassword, generateSecretKey, deleteAppSecret, readAppSecret, writeAppSecret,
  isAppSecretName,
} from '../infrastructure/secrets';
import type { AppManifest, CredentialMeta, SecretSpec } from './types';

/** The generator for a declared secret (an unknown kind is a password, as at install). */
export function secretGenerator(type: string, length: number): () => string {
  switch (type) {
    case 'password': return () => generatePassword(length);
    case 'secretKey': return () => generateSecretKey(length);
    case 'hexToken': return () => generateHexToken(length);
    default: return () => generatePassword(length);
  }
}

/** The install record's `credentials` for a manifest: what Settings → Apps → Credentials shows. */
export function credentialRecords(manifest: Pick<AppManifest, 'credentials'>): CredentialMeta[] | undefined {
  return manifest.credentials?.length
    ? manifest.credentials.map((c) => ({ label: c.label, username: c.username, passwordSecret: c.passwordSecret }))
    : undefined;
}

/** The journal step that generated one secret during an update. */
export const GENERATED_SECRET_STEP = 'generate-secret-';

export function generatedSecretStep(name: string): string {
  if (!isAppSecretName(name)) throw new Error('Invalid app secret name');
  return `${GENERATED_SECRET_STEP}${name}`;
}

/**
 * The secrets the update may generate: declared by the target manifest, **never declared by the installed one**, and
 * without a value (no value was read and the read did not fail). A secret the installed version already declared is
 * never generated, even when it reads as missing or empty (YE-217): its data (an encryption key, a session secret)
 * was made with the old value, so a new one would make it unreadable. See `lostInstalledSecrets`.
 */
export function missingSecrets(
  target: Pick<AppManifest, 'secrets'>, installed: Pick<AppManifest, 'secrets'>,
  existing: Record<string, string | undefined>, unreadable: ReadonlySet<string>,
): SecretSpec[] {
  const declared = new Set((installed.secrets ?? []).map((secret) => secret.name));
  return target.secrets.filter((secret) => !declared.has(secret.name) && !existing[secret.name] && !unreadable.has(secret.name));
}

/**
 * Secrets the installed version declared and the target still declares that have no usable value: missing, empty or
 * whitespace only, or unreadable. Before 0.6.3 an install kept its secrets at `app-<id>/<file>`, which today's store
 * (`app-<id>/secrets/<name>`) does not read, so such an app lands here. The update stops on these (YE-217).
 */
export function lostInstalledSecrets(
  target: Pick<AppManifest, 'secrets'>, installed: Pick<AppManifest, 'secrets'>,
  existing: Record<string, string | undefined>,
): string[] {
  const declared = new Set((installed.secrets ?? []).map((secret) => secret.name));
  return target.secrets.filter((secret) => declared.has(secret.name) && !existing[secret.name]).map((secret) => secret.name);
}

/** The update stops before changing anything: a secret the installed version declared has no usable value. */
export class InstalledSecretMissingError extends Error {
  readonly code = 'installed-secret-missing';
  constructor(appId: string, names: string[]) {
    const list = names.join(', ');
    super(`The update of ${appId} stopped before changing anything: the installed version uses the secret${names.length > 1 ? 's' : ''} `
      + `${list}, but ${names.length > 1 ? 'they are' : 'it is'} missing, empty or unreadable on this box (an app installed before 0.6.3 `
      + 'keeps its secrets in an older place). A new value would make the data the app saved with the old one unreadable, '
      + 'so none is made. Restore the secret file, then update again.');
    this.name = 'InstalledSecretMissingError';
  }
}

/** Generate and write one missing secret; refuses when it exists by now (a secret is never regenerated). */
export async function createMissingSecret(
  appId: string, secret: Pick<SecretSpec, 'name' | 'generator' | 'length'>,
  store: { read: typeof readAppSecret; write: typeof writeAppSecret } = { read: readAppSecret, write: writeAppSecret },
): Promise<string> {
  if (await store.read(appId, secret.name) !== null) throw new Error(`The secret ${secret.name} of ${appId} exists already`);
  const value = secretGenerator(secret.generator, secret.length)();
  await store.write(appId, secret.name, value);
  return value;
}

/** The secrets an update operation generated, from its journal steps (intended or completed). */
export function generatedSecretNames(record: { steps: ReadonlyArray<{ id?: string }> }): string[] {
  return record.steps
    .map((step) => step.id)
    .filter((id): id is string => typeof id === 'string' && id.startsWith(GENERATED_SECRET_STEP))
    .map((id) => id.slice(GENERATED_SECRET_STEP.length))
    .filter(isAppSecretName);
}

/** Rollback: delete the secrets this update generated (idempotent: an absent one is fine). */
export async function removeGeneratedSecrets(
  record: { appId: string; steps: ReadonlyArray<{ id?: string }> },
  remove: typeof deleteAppSecret = deleteAppSecret,
): Promise<string[]> {
  const names = generatedSecretNames(record);
  for (const name of names) await remove(record.appId, name);
  return names;
}
