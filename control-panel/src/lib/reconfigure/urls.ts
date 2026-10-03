/** Replace domain and public identity together, so identity-label changes compose.
 * Domain-independent issuer values and unrelated secrets stay unchanged.
 */
export function replacePlatformUrls(value: string, oldDomain: string, newDomain: string, identityOrigins?: [string, string]): string {
  const next = oldDomain === newDomain ? value : value.split(oldDomain).join(newDomain);
  if (!identityOrigins) return next;
  const migratedOldOrigin = identityOrigins[0].split(oldDomain).join(newDomain);
  return next.split(migratedOldOrigin).join(identityOrigins[1]);
}
