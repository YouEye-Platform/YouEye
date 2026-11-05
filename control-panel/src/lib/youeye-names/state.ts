import crypto from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { IDENTITY_DATA_DIR } from './identity';

const STATE_FILE = path.join(IDENTITY_DATA_DIR, 'lifecycle.json');
const stateSchema = z
  .object({
    schemaVersion: z.literal(2),
    service: z.object({
      id: z.string().min(3).max(64),
      canonicalOrigin: z.string().url(),
      apiVersion: z.literal('v1'),
      managedZone: z.string().min(1).max(253),
    }).strict(),
    name: z.string().min(1).max(63),
    fqdn: z.string().min(1).max(253),
    status: z.enum(['provisioning', 'healthy', 'renewing', 'attention', 'released']),
    provisioning: z.object({
      stage: z.enum(['lease_claimed', 'certificate_requested', 'certificate_waiting', 'certificate_received', 'activating']),
      startedAt: z.string().datetime({ offset: true }),
      lastAttemptAt: z.string().datetime({ offset: true }),
      brokerRequestId: z.string().min(1).max(256).nullable(),
      privateKeyPem: z.string().min(64).max(64 * 1024).nullable(),
      csrPem: z.string().min(128).max(64 * 1024).nullable(),
    }).strict().nullable(),
    termsVersion: z.string().min(1).max(64).nullable(),
    certificateTransparencyAcceptedAt: z.string().datetime({ offset: true }).nullable(),
    certificate: z
      .object({
        fingerprint: z.string().min(32).max(256),
        provider: z.enum(['letsencrypt', 'google-public-ca']).nullable(),
        issuedAt: z.string().datetime({ offset: true }),
        expiresAt: z.string().datetime({ offset: true }),
      })
      .strict().nullable(),
    lastBrokerContactAt: z.string().datetime({ offset: true }).nullable(),
    lastHeartbeatAt: z.string().datetime({ offset: true }).nullable(),
    nextCheckAt: z.string().datetime({ offset: true }).nullable(),
    lastError: z
      .object({
        code: z.string().min(1).max(256),
        requestId: z.string().min(1).max(256).nullable(),
        at: z.string().datetime({ offset: true }),
        retryAfterSeconds: z.number().nonnegative().nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();

export type NamesLifecycleState = z.infer<typeof stateSchema>;

async function fsyncDirectory(): Promise<void> {
  const handle = await fs.open(IDENTITY_DATA_DIR, fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function readNamesLifecycleState(): Promise<NamesLifecycleState | null> {
  try {
    const stat = await fs.lstat(STATE_FILE);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) {
      throw new Error('youeye_names_lifecycle_file_unsafe');
    }
    if (stat.size > 128 * 1024) {
      throw new Error('youeye_names_lifecycle_file_too_large');
    }
    const value = JSON.parse(await fs.readFile(STATE_FILE, 'utf8')) as unknown;
    const result = stateSchema.safeParse(value);
    if (!result.success) throw new Error('youeye_names_lifecycle_state_invalid');
    return result.data;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (error instanceof SyntaxError) {
      throw new Error('youeye_names_lifecycle_json_invalid');
    }
    throw error;
  }
}

export async function writeNamesLifecycleState(
  value: NamesLifecycleState,
): Promise<void> {
  const parsed = stateSchema.parse(value);
  await fs.mkdir(IDENTITY_DATA_DIR, { recursive: true, mode: 0o700 });
  await fs.chmod(IDENTITY_DATA_DIR, 0o700);
  const temporary = path.join(
    IDENTITY_DATA_DIR,
    `.lifecycle.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`,
  );
  const handle = await fs.open(
    temporary,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
    await handle.sync();
  } catch (error) {
    await handle.close();
    await fs.unlink(temporary).catch(() => undefined);
    throw error;
  }
  await handle.close();
  await fs.rename(temporary, STATE_FILE);
  await fs.chmod(STATE_FILE, 0o600);
  await fsyncDirectory();
}

export async function updateNamesLifecycleState(
  update: (current: NamesLifecycleState) => NamesLifecycleState,
): Promise<NamesLifecycleState | null> {
  const current = await readNamesLifecycleState();
  if (!current) return null;
  const next = stateSchema.parse(update(current));
  await writeNamesLifecycleState(next);
  return next;
}

export const NAMES_LIFECYCLE_FILE_PATH = STATE_FILE;
