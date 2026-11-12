/** The one username rule for YouEye ID accounts: 3–32 characters of [a-z0-9._-], starting with a letter. */
export const IDENTITY_USERNAME_PATTERN = /^[a-z][a-z0-9._-]{2,31}$/;

export function validateIdentityUsername(username: unknown): string | null {
  if (typeof username !== 'string' || !IDENTITY_USERNAME_PATTERN.test(username)) {
    return 'Username must be 3-32 characters and start with a lowercase letter.';
  }
  return null;
}

export function requireIdentityUsername(username: unknown): asserts username is string {
  const error = validateIdentityUsername(username);
  if (error) throw new Error(error);
}
