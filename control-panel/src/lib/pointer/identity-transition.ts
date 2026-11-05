import { execCommand } from '@/lib/incus/server';
import { readSecret } from '@/lib/infrastructure/secrets';
import { CONTAINER_DOMAIN } from '@/lib/market/constants';
import { POINTER_PLATFORM_AUDIENCE, POINTER_PLATFORM_SUBJECT } from '@/lib/identity/tokens';
import type { PointerIdentityChange } from './identity-rename';

export async function transitionPointerIdentity(change: PointerIdentityChange, checkOnly: boolean): Promise<'ready' | 'changed' | 'already-applied'> {
  const password = await readSecret('postgres', '.pg_password');
  if (!password) throw new Error('PostgreSQL credential is unavailable');
  const result = await execCommand('youeye-pointer', [
    '/opt/pointer/bun', '/opt/pointer/transition-managed-identity.js', '--expect-database', 'pointer',
    ...(checkOnly ? ['--check'] : []),
  ], {
    environment: {
      DATABASE_URL: `postgresql://youeye:${encodeURIComponent(password)}@youeye-postgres.${CONTAINER_DOMAIN}:5432/pointer`,
      POINTER_IDENTITY_TRANSITION: JSON.stringify({
        ...change, integrationId: 'youeye-native', audience: POINTER_PLATFORM_AUDIENCE, subject: POINTER_PLATFORM_SUBJECT,
      }),
    },
    timeout: 30_000,
  });
  if (result.exitCode !== 0) {
    throw new Error('YouEye AI identity transition is unavailable or rejected. Update YouEye AI and verify its existing integration before renaming.');
  }
  let receipt: { schema?: string; result?: string };
  try { receipt = JSON.parse(result.stdout); }
  catch { throw new Error('YouEye AI identity transition returned an invalid receipt'); }
  if (receipt.schema !== 'pointer.identity-transition.v1'
    || !['ready', 'changed', 'already-applied'].includes(receipt.result || '')) {
    throw new Error('YouEye AI identity transition returned an invalid receipt');
  }
  return receipt.result as 'ready' | 'changed' | 'already-applied';
}
