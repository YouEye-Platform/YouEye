/**
 * Owner password reset with the one-time code the box's console shows after
 * Recovery's "Reset owner password". Spine checks and consumes the code; a
 * valid code sets the owner's YouEye ID password (which also becomes their
 * console password) and ends the owner's sessions. Every refusal of the code
 * looks the same, so the page never tells whether a reset is pending.
 */
import { SpineAPIError } from '@/lib/spine/client';
import { validateIdentityPassword } from '@/lib/identity/password-policy';

export interface OwnerResetDeps {
  ownerId: () => Promise<string | null>;
  useCode: (code: string) => Promise<unknown>;
  setPassword: (userId: string, password: string) => Promise<void>;
  revokeSessions: (userId: string) => Promise<unknown>;
  log: (message: string) => void;
}

export type OwnerResetResult =
  | { status: 200; code: 'reset' }
  | { status: 400 | 403 | 500 | 503; code: 'invalid_code' | 'invalid_password' | 'password_mismatch' | 'unavailable'; error: string };

const MESSAGES = {
  invalid_code: 'The code is not valid',
  password_mismatch: 'Passwords do not match',
  unavailable: 'The password could not be reset. Try again.',
} as const;

function reason(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}

export async function resetOwnerPassword(body: unknown, deps: OwnerResetDeps): Promise<OwnerResetResult> {
  const input = (body && typeof body === 'object' ? body : {}) as { code?: unknown; password?: unknown; repeatPassword?: unknown };
  const code = typeof input.code === 'string' ? input.code.trim() : '';
  if (!code || code.length > 64) return { status: 403, code: 'invalid_code', error: MESSAGES.invalid_code };
  // The password is checked before the code is spent.
  const passwordError = validateIdentityPassword(input.password);
  if (passwordError) return { status: 400, code: 'invalid_password', error: passwordError };
  if (input.password !== input.repeatPassword) return { status: 400, code: 'password_mismatch', error: MESSAGES.password_mismatch };
  const password = input.password as string;

  let ownerId: string | null;
  try {
    ownerId = await deps.ownerId();
  } catch (error) {
    deps.log(`[owner-reset] The owner could not be read: ${reason(error)}`);
    return { status: 503, code: 'unavailable', error: MESSAGES.unavailable };
  }
  if (!ownerId) return { status: 403, code: 'invalid_code', error: MESSAGES.invalid_code };

  try {
    await deps.useCode(code);
  } catch (error) {
    // 403: wrong, used or expired code, or none pending; 409: not a sealed appliance.
    if (error instanceof SpineAPIError && (error.statusCode === 403 || error.statusCode === 409)) {
      return { status: 403, code: 'invalid_code', error: MESSAGES.invalid_code };
    }
    deps.log(`[owner-reset] The reset code could not be checked: ${reason(error)}`);
    return { status: 503, code: 'unavailable', error: MESSAGES.unavailable };
  }

  try {
    await deps.setPassword(ownerId, password);
    await deps.revokeSessions(ownerId);
  } catch (error) {
    deps.log(`[owner-reset] The owner password was not changed after a valid code: ${reason(error)}`);
    return { status: 500, code: 'unavailable', error: MESSAGES.unavailable };
  }
  deps.log('[owner-reset] The owner password was reset with a console code');
  return { status: 200, code: 'reset' };
}
