export const IDENTITY_PASSWORD_MIN_LENGTH = 8;
export const IDENTITY_PASSWORD_MAX_LENGTH = 256;

export function validateIdentityPassword(password: unknown): string | null {
  if (typeof password !== 'string') return 'Password is required.';
  if (password.length < IDENTITY_PASSWORD_MIN_LENGTH || password.length > IDENTITY_PASSWORD_MAX_LENGTH) {
    return `Password must be between ${IDENTITY_PASSWORD_MIN_LENGTH} and ${IDENTITY_PASSWORD_MAX_LENGTH} characters.`;
  }
  // The same password signs in on the box's console, which takes one line.
  if (/[\u0000-\u001f\u007f]/.test(password)) return 'Password must not contain line breaks or control characters.';
  return null;
}

export function requireIdentityPassword(password: unknown): asserts password is string {
  const error = validateIdentityPassword(password);
  if (error) throw new Error(error);
}
