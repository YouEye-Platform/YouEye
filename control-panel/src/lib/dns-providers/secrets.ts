import { deleteSecret, readSecret, secretExists, writeSecret } from '@/lib/infrastructure/secrets';

const SECRET_ROOT = 'system-dns-providers';

function scope(connectionId: string): string {
  return `${SECRET_ROOT}/${connectionId}`;
}

export async function readProviderToken(connectionId: string): Promise<string | null> {
  return readSecret(scope(connectionId), 'token');
}

export async function writeProviderToken(connectionId: string, token: string): Promise<void> {
  await writeSecret(scope(connectionId), 'token', token);
}

export async function deleteProviderToken(connectionId: string): Promise<void> {
  await deleteSecret(scope(connectionId), 'token');
}

export async function providerTokenExists(connectionId: string): Promise<boolean> {
  return secretExists(scope(connectionId), 'token');
}
